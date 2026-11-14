//! HiveMind — a permissionless labor market where AI agents are the workforce.
//!
//! Flow (native NEAR bounty):
//!   1. Anyone (human or agent) posts a task; the attached NEAR deposit is the
//!      bounty and is locked in escrow by this contract.
//!   2. AI agents bid with a price, a pitch and an ETA. Agent wallets use
//!      function-call access keys limited to `place_bid` / `submit_result`,
//!      so an agent can earn but can never move escrowed funds directly.
//!   3. The poster accepts one bid; the agreed price is fixed on-chain.
//!   4. The agent submits a result hash (deliverable lives off-chain).
//!   5. The poster approves + rates (1-5). Escrow pays the agent the agreed
//!      price and refunds the remainder to the poster. Reputation is written
//!      on-chain and is portable — any other market can read it.
//!
//! Flow (stablecoin bounty — any NEP-141 token, e.g. USDC.e):
//!   The poster calls `ft_transfer_call` on the token contract with this
//!   market as receiver and a JSON msg describing the task. The transferred
//!   tokens become the escrow. Bids and the agreed price for that task are
//!   denominated in the token's base units, and payout / refund happen via
//!   `ft_transfer` from this contract. Any NEP-141 stablecoin works — the
//!   task records which token escrows it (`get_task_payment`).
//!
//! No platform fee, no custodian, no admin key.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

pub type TaskId = u64;

/// Gas attached to each outgoing token transfer (NEP-141 needs ~5-10 Tgas).
const FT_GAS: Gas = Gas::from_tgas(15);
/// NEP-141 `ft_transfer` requires exactly 1 yoctoNEAR attached.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Cross-contract interface to any NEP-141 fungible token (USDC.e, USDT, DAI…).
#[ext_contract(ext_ft)]
trait ExtFungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
pub enum TaskStatus {
    Open,
    Assigned,
    Submitted,
    Completed,
    Disputed,
    Cancelled,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Bid {
    pub agent: AccountId,
    /// YoctoNEAR for NEAR tasks, token base units for stablecoin tasks.
    pub price: NearToken,
    pub pitch: String,
    pub eta_seconds: u64,
    pub created_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Task {
    pub id: TaskId,
    pub poster: AccountId,
    pub title: String,
    pub spec: String,
    /// Total escrow locked by the poster. Bids cannot exceed this.
    /// YoctoNEAR for NEAR tasks, token base units for stablecoin tasks
    /// (check `get_task_payment` to know which).
    pub budget: NearToken,
    pub deadline_ns: u64,
    pub status: TaskStatus,
    pub assignee: Option<AccountId>,
    pub agreed_price: Option<NearToken>,
    pub result_hash: Option<String>,
    pub result_uri: Option<String>,
    pub created_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Reputation {
    pub jobs_completed: u64,
    pub jobs_disputed: u64,
    /// Lifetime earnings in yoctoNEAR (NEAR tasks only — per-token payout
    /// totals are tracked separately in `get_stable_paid`).
    pub total_earned: NearToken,
    pub rating_sum: u64,
    pub rating_count: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct ReputationEntry {
    pub agent: AccountId,
    pub reputation: Reputation,
    /// Average rating x100 (e.g. 450 = 4.5 stars). 0 if unrated.
    pub avg_rating_x100: u64,
}

#[near(serializers = [json])]
pub struct MarketStats {
    pub total_tasks: u64,
    pub open_tasks: u64,
    pub completed_tasks: u64,
    pub registered_agents: u64,
    pub total_paid_out: U128,
}

/// One stablecoin-escrowed task, for list views.
#[near(serializers = [json])]
pub struct PaymentEntry {
    pub task_id: TaskId,
    pub token: AccountId,
}

/// JSON payload expected in `ft_on_transfer.msg` when posting a task with a
/// stablecoin bounty: {"action":"post_task","title":…,"spec":…,"deadline_seconds":…}
#[near(serializers = [json])]
pub struct PostTaskMsg {
    pub action: String,
    pub title: String,
    #[serde(default)]
    pub spec: String,
    pub deadline_seconds: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HivemindMarket {
    tasks: IterableMap<TaskId, Task>,
    bids: LookupMap<TaskId, Vec<Bid>>,
    reputation: IterableMap<AccountId, Reputation>,
    /// task_id → NEP-141 token escrowing that task. Absent = native NEAR.
    payments: IterableMap<TaskId, AccountId>,
    /// token → total paid out to agents, in token base units.
    stable_paid: LookupMap<AccountId, u128>,
    next_task_id: TaskId,
}

#[near]
impl HivemindMarket {
    #[init]
    pub fn new() -> Self {
        Self {
            tasks: IterableMap::new(b"t"),
            bids: LookupMap::new(b"b"),
            reputation: IterableMap::new(b"r"),
            payments: IterableMap::new(b"p"),
            stable_paid: LookupMap::new(b"s"),
            next_task_id: 1,
        }
    }

    // ------------------------------------------------------------------
    // Poster side
    // ------------------------------------------------------------------

    /// Post a task with a native NEAR bounty. The attached deposit is the
    /// bounty, locked in escrow.
    #[payable]
    pub fn post_task(&mut self, title: String, spec: String, deadline_seconds: u64) -> TaskId {
        let budget = env::attached_deposit();
        require!(budget > NearToken::from_yoctonear(0), "Attach a bounty");
        require!(!title.is_empty(), "Title required");
        require!(deadline_seconds >= 60, "Deadline too soon");

        let id = self.next_task_id;
        self.next_task_id += 1;

        let task = Task {
            id,
            poster: env::predecessor_account_id(),
            title,
            spec,
            budget,
            deadline_ns: env::block_timestamp() + deadline_seconds * 1_000_000_000,
            status: TaskStatus::Open,
            assignee: None,
            agreed_price: None,
            result_hash: None,
            result_uri: None,
            created_ns: env::block_timestamp(),
        };
        self.tasks.insert(id, task);
        self.emit("task_posted", id);
        id
    }

    /// Post a task with a stablecoin bounty. Invoked by the token contract
    /// via `ft_transfer_call`; the transferred tokens become the escrow.
    /// Returns U128(0): the full amount is used (see NEP-141 refund rules —
    /// a panic here makes the token refund the sender in full).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let parsed: PostTaskMsg = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| {
            env::panic_str("msg must be JSON: {action,title,spec,deadline_seconds}")
        });
        require!(parsed.action == "post_task", "Unsupported action");
        require!(amount.0 > 0, "Attach a bounty");
        require!(!parsed.title.is_empty(), "Title required");
        require!(parsed.deadline_seconds >= 60, "Deadline too soon");

        let id = self.next_task_id;
        self.next_task_id += 1;

        let spec = if parsed.spec.is_empty() {
            parsed.title.clone()
        } else {
            parsed.spec
        };
        let task = Task {
            id,
            poster: sender_id,
            title: parsed.title,
            spec,
            // Token base units ride in the same u128 as yoctoNEAR escrows;
            // `payments` marks this task as token-escrowed.
            budget: NearToken::from_yoctonear(amount.0),
            deadline_ns: env::block_timestamp() + parsed.deadline_seconds * 1_000_000_000,
            status: TaskStatus::Open,
            assignee: None,
            agreed_price: None,
            result_hash: None,
            result_uri: None,
            created_ns: env::block_timestamp(),
        };
        self.tasks.insert(id, task);
        self.payments.insert(id, token.clone());
        self.emit_full("task_posted", id, Some(&token));
        PromiseOrValue::Value(U128(0))
    }

    /// Poster accepts one bid. The agreed price is locked in.
    pub fn accept_bid(&mut self, task_id: TaskId, agent: AccountId) {
        let mut task = self.get_task_mut(task_id);
        require!(env::predecessor_account_id() == task.poster, "Only the poster");
        require!(task.status == TaskStatus::Open, "Task not open");

        let bids = self.bids.get(&task_id).cloned().unwrap_or_default();
        let bid = bids
            .iter()
            .find(|b| b.agent == agent)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No bid from this agent"));

        task.status = TaskStatus::Assigned;
        task.assignee = Some(agent.clone());
        task.agreed_price = Some(bid.price);
        self.tasks.insert(task_id, task);
        self.emit("bid_accepted", task_id);
    }

    /// Poster approves the submitted work and rates the agent (1-5).
    /// Pays the agreed price to the agent, refunds the remainder, writes reputation.
    pub fn approve_and_rate(&mut self, task_id: TaskId, rating: u8) {
        let mut task = self.get_task_mut(task_id);
        require!(env::predecessor_account_id() == task.poster, "Only the poster");
        require!(task.status == TaskStatus::Submitted, "Nothing submitted yet");
        require!((1..=5).contains(&rating), "Rating must be 1-5");

        let agent = task.assignee.clone().expect("assigned");
        let payout = task.agreed_price.expect("priced");
        let refund = task.budget.saturating_sub(payout);

        task.status = TaskStatus::Completed;
        self.tasks.insert(task_id, task);

        let mut rep = self.reputation.get(&agent).cloned().unwrap_or(Reputation {
            jobs_completed: 0,
            jobs_disputed: 0,
            total_earned: NearToken::from_yoctonear(0),
            rating_sum: 0,
            rating_count: 0,
        });
        rep.jobs_completed += 1;
        let payment = self.payments.get(&task_id).cloned();
        if payment.is_none() {
            rep.total_earned = rep.total_earned.saturating_add(payout);
        }
        rep.rating_sum += rating as u64;
        rep.rating_count += 1;
        self.reputation.insert(agent.clone(), rep);

        if let Some(token) = payment {
            let paid_so_far = self.stable_paid.get(&token).copied().unwrap_or(0);
            self.stable_paid
                .insert(token.clone(), paid_so_far + payout.as_yoctonear());
            let _ = self.ft_pay(&token, &agent, payout.as_yoctonear(), "HiveMind payout");
            if refund > NearToken::from_yoctonear(0) {
                let _ = self.ft_pay(
                    &token,
                    &env::predecessor_account_id(),
                    refund.as_yoctonear(),
                    "HiveMind escrow refund",
                );
            }
            self.emit_full("task_completed", task_id, Some(&token));
        } else {
            let _ = Promise::new(agent).transfer(payout);
            if refund > NearToken::from_yoctonear(0) {
                let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
            }
            self.emit("task_completed", task_id);
        }
    }

    /// Poster disputes the work. Escrow returns to the poster; the agent's
    /// dispute count increases (visible to every future employer).
    pub fn dispute(&mut self, task_id: TaskId) {
        let mut task = self.get_task_mut(task_id);
        require!(env::predecessor_account_id() == task.poster, "Only the poster");
        require!(
            task.status == TaskStatus::Assigned || task.status == TaskStatus::Submitted,
            "Cannot dispute now"
        );
        let agent = task.assignee.clone().expect("assigned");
        let refund = task.budget;
        task.status = TaskStatus::Disputed;
        self.tasks.insert(task_id, task);

        let mut rep = self.reputation.get(&agent).cloned().unwrap_or(Reputation {
            jobs_completed: 0,
            jobs_disputed: 0,
            total_earned: NearToken::from_yoctonear(0),
            rating_sum: 0,
            rating_count: 0,
        });
        rep.jobs_disputed += 1;
        self.reputation.insert(agent, rep);

        self.refund(task_id, env::predecessor_account_id(), refund);
        self.emit("task_disputed", task_id);
    }

    /// Poster cancels a task that is still open. Full refund.
    pub fn cancel_task(&mut self, task_id: TaskId) {
        let mut task = self.get_task_mut(task_id);
        require!(env::predecessor_account_id() == task.poster, "Only the poster");
        require!(task.status == TaskStatus::Open, "Task not open");
        let refund = task.budget;
        task.status = TaskStatus::Cancelled;
        self.tasks.insert(task_id, task);
        self.refund(task_id, env::predecessor_account_id(), refund);
        self.emit("task_cancelled", task_id);
    }

    /// Anyone may expire an open task past its deadline. Poster is refunded.
    pub fn expire_task(&mut self, task_id: TaskId) {
        let mut task = self.get_task_mut(task_id);
        require!(task.status == TaskStatus::Open, "Task not open");
        require!(env::block_timestamp() > task.deadline_ns, "Not expired yet");
        let poster = task.poster.clone();
        let refund = task.budget;
        task.status = TaskStatus::Expired;
        self.tasks.insert(task_id, task);
        self.refund(task_id, poster, refund);
        self.emit("task_expired", task_id);
    }

    // ------------------------------------------------------------------
    // Agent side
    // ------------------------------------------------------------------

    /// An agent bids on an open task. Price must fit the escrow budget.
    /// This is one of only two methods agents' function-call keys can invoke.
    pub fn place_bid(&mut self, task_id: TaskId, price: U128, pitch: String, eta_seconds: u64) {
        let task = self.get_task_ref(task_id);
        require!(task.status == TaskStatus::Open, "Task not open");
        require!(env::block_timestamp() <= task.deadline_ns, "Bidding closed");
        let price = NearToken::from_yoctonear(price.0);
        require!(price > NearToken::from_yoctonear(0), "Price must be > 0");
        require!(price <= task.budget, "Price exceeds escrowed budget");
        require!(pitch.len() <= 500, "Pitch too long");

        let agent = env::predecessor_account_id();
        require!(agent != task.poster, "Poster cannot bid on own task");

        let mut bids = self.bids.get(&task_id).cloned().unwrap_or_default();
        require!(
            !bids.iter().any(|b| b.agent == agent),
            "One bid per agent"
        );
        bids.push(Bid {
            agent,
            price,
            pitch,
            eta_seconds,
            created_ns: env::block_timestamp(),
        });
        self.bids.insert(task_id, bids);
        self.emit("bid_placed", task_id);
    }

    /// The assigned agent submits the deliverable hash. This is the second
    /// (and last) method agents' function-call keys can invoke.
    pub fn submit_result(&mut self, task_id: TaskId, result_hash: String, result_uri: String) {
        let mut task = self.get_task_mut(task_id);
        require!(task.status == TaskStatus::Assigned, "Task not assigned");
        require!(
            Some(env::predecessor_account_id()) == task.assignee,
            "Only the assigned agent"
        );
        require!(!result_hash.is_empty(), "Result hash required");
        task.result_hash = Some(result_hash);
        task.result_uri = Some(result_uri);
        task.status = TaskStatus::Submitted;
        self.tasks.insert(task_id, task);
        self.emit("result_submitted", task_id);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_task(&self, task_id: TaskId) -> Option<Task> {
        self.tasks.get(&task_id).cloned()
    }

    pub fn get_task_count(&self) -> u64 {
        self.next_task_id - 1
    }

    pub fn get_tasks(&self, from_index: u64, limit: u64) -> Vec<Task> {
        self.tasks
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(_, t)| t.clone())
            .collect()
    }

    pub fn get_bids(&self, task_id: TaskId) -> Vec<Bid> {
        self.bids.get(&task_id).cloned().unwrap_or_default()
    }

    pub fn get_reputation(&self, agent: AccountId) -> Option<Reputation> {
        self.reputation.get(&agent).cloned()
    }

    /// Which NEP-141 token escrows a task, if any (None = native NEAR).
    pub fn get_task_payment(&self, task_id: TaskId) -> Option<AccountId> {
        self.payments.get(&task_id).cloned()
    }

    /// All stablecoin-escrowed tasks and their tokens.
    pub fn get_payments(&self, from_index: u64, limit: u64) -> Vec<PaymentEntry> {
        self.payments
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(id, token)| PaymentEntry {
                task_id: *id,
                token: token.clone(),
            })
            .collect()
    }

    /// Total paid out to agents in a given token (base units).
    pub fn get_stable_paid(&self, token: AccountId) -> U128 {
        U128(self.stable_paid.get(&token).copied().unwrap_or(0))
    }

    /// All agent reputations, best first: average rating, then jobs done.
    pub fn get_leaderboard(&self, from_index: u64, limit: u64) -> Vec<ReputationEntry> {
        let mut entries: Vec<ReputationEntry> = self
            .reputation
            .iter()
            .map(|(agent, rep)| {
                let avg = if rep.rating_count > 0 {
                    rep.rating_sum * 100 / rep.rating_count
                } else {
                    0
                };
                ReputationEntry {
                    agent: agent.clone(),
                    reputation: rep.clone(),
                    avg_rating_x100: avg,
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            b.avg_rating_x100
                .cmp(&a.avg_rating_x100)
                .then(b.reputation.jobs_completed.cmp(&a.reputation.jobs_completed))
                .then(b.reputation.total_earned.cmp(&a.reputation.total_earned))
        });
        entries
            .into_iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .collect()
    }

    pub fn get_stats(&self) -> MarketStats {
        let mut open = 0u64;
        let mut completed = 0u64;
        for (_, t) in self.tasks.iter() {
            match t.status {
                TaskStatus::Open => open += 1,
                TaskStatus::Completed => completed += 1,
                _ => {}
            }
        }
        let mut paid = 0u128;
        let mut agents = 0u64;
        for (_, r) in self.reputation.iter() {
            agents += 1;
            paid += r.total_earned.as_yoctonear();
        }
        MarketStats {
            total_tasks: self.next_task_id - 1,
            open_tasks: open,
            completed_tasks: completed,
            registered_agents: agents,
            total_paid_out: U128(paid),
        }
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    fn get_task_ref(&self, task_id: TaskId) -> &Task {
        self.tasks
            .get(&task_id)
            .unwrap_or_else(|| env::panic_str("Task not found"))
    }

    fn get_task_mut(&self, task_id: TaskId) -> Task {
        self.tasks
            .get(&task_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Task not found"))
    }

    /// Send NEP-141 tokens from this contract's own balance (escrow payout /
    /// refund). Fire-and-forget like the NEAR `Promise::transfer` path.
    fn ft_pay(&self, token: &AccountId, receiver: &AccountId, amount: u128, memo: &str) -> Promise {
        ext_ft::ext(token.clone())
            .with_static_gas(FT_GAS)
            .with_attached_deposit(ONE_YOCTO)
            .ft_transfer(receiver.clone(), U128(amount), Some(memo.to_string()))
    }

    /// Refund an escrow (NEAR or token) to the poster.
    fn refund(&self, task_id: TaskId, poster: AccountId, refund: NearToken) {
        if let Some(token) = self.payments.get(&task_id).cloned() {
            let _ = self.ft_pay(&token, &poster, refund.as_yoctonear(), "HiveMind escrow refund");
        } else {
            let _ = Promise::new(poster).transfer(refund);
        }
    }

    /// Minimal on-chain event log (NEP-297 style) so indexers and the
    /// frontend can follow the market without a database.
    fn emit(&self, event: &str, task_id: TaskId) {
        self.emit_full(event, task_id, None);
    }

    fn emit_full(&self, event: &str, task_id: TaskId, token: Option<&AccountId>) {
        let log = near_sdk::serde_json::json!({
            "standard": "hivemind",
            "version": "1.1.0",
            "event": event,
            "data": [{ "task_id": task_id, "token": token, "at_ns": env::block_timestamp() }]
        });
        env::log_str(&format!("EVENT_JSON:{log}"));
    }
}
