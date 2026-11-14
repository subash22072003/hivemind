/**
 * Agent brains. If NEAR_AI_API_KEY is set, agents think with NEAR AI Cloud
 * (OpenAI-compatible). Otherwise they run in deterministic mock mode so the
 * whole demo is reproducible with zero external dependencies.
 */

function makeLlm(cfg, log = () => {}) {
  const hasKey = Boolean(cfg.nearAi.apiKey);
  if (hasKey) {
    log(`🧠 Brains: NEAR AI Cloud (${cfg.nearAi.model})`);
  } else {
    log('🧠 Brains: mock mode (set NEAR_AI_API_KEY to use NEAR AI Cloud)');
  }

  async function chat(system, user) {
    const res = await fetch(`${cfg.nearAi.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.nearAi.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.nearAi.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
      }),
    });
    if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content;
  }

  function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in model output');
    return JSON.parse(m[0]);
  }

  return {
    live: hasKey,

    /** Worker decides its bid for a task. Returns {priceNEAR, pitch, etaSec}. */
    async decideBid(task, personality, budgetNEAR) {
      if (!hasKey) {
        const priceNEAR = Math.max(0.05, budgetNEAR * personality.priceFactor);
        return {
          priceNEAR: Number(priceNEAR.toFixed(3)),
          pitch: `${personality.name} — ${personality.style}: ${personality.blurb}.`,
          etaSec: personality.etaSec,
        };
      }
      try {
        const out = await chat(
          `You are ${personality.name}, an autonomous freelance AI agent. Your style: ${personality.style} (${personality.blurb}). You must win work without bidding above the budget. Reply with ONLY JSON: {"priceNEAR": number, "pitch": string <= 280 chars, "etaSec": number}.`,
          `Task: "${task.title}"\nSpec: ${task.spec}\nBudget cap: ${budgetNEAR} NEAR. What do you bid?`
        );
        const j = extractJson(out);
        return {
          priceNEAR: Math.min(Number(j.priceNEAR) || budgetNEAR * personality.priceFactor, budgetNEAR),
          pitch: String(j.pitch || `${personality.name} can do this.`).slice(0, 280),
          etaSec: Number(j.etaSec) || personality.etaSec,
        };
      } catch (e) {
        log(`   ⚠️  LLM bid failed (${e.message}), using fallback`);
        const priceNEAR = Math.max(0.05, budgetNEAR * personality.priceFactor);
        return { priceNEAR: Number(priceNEAR.toFixed(3)), pitch: `${personality.name}: ${personality.style}.`, etaSec: personality.etaSec };
      }
    },

    /** Worker produces the deliverable. Returns markdown text. */
    async doWork(task, personality) {
      if (!hasKey) {
        return (
          `# ${task.title}\n\n` +
          `*Delivered by ${personality.name} (${personality.style})*\n\n` +
          `Mock deliverable for the spec:\n\n> ${task.spec}\n\n` +
          `In live mode this section is written by NEAR AI Cloud. Quality tier: ${personality.quality}/5.`
        );
      }
      return chat(
        `You are ${personality.name}, an autonomous AI freelancer (${personality.style}). Complete the client's task properly and return only the deliverable in markdown.`,
        `Task: "${task.title}"\nSpec: ${task.spec}`
      );
    },

    /** Poster picks a winner. Returns the chosen agent account id. */
    async chooseBid(task, bids, reputations) {
      if (!hasKey) {
        // Score = quality proxy (rating) per NEAR; slight preference for reputation.
        let best = bids[0];
        let bestScore = -1;
        for (const b of bids) {
          const rep = reputations[b.agent] || { ratingAvg: 0, jobs: 0 };
          // Unrated agents score as 2.5 — a proven track record beats an unknown one.
          const score = ((rep.ratingAvg || 2.5) + rep.jobs * 0.1) / b.priceNEAR;
          if (score > bestScore) {
            bestScore = score;
            best = b;
          }
        }
        return best.agent;
      }
      try {
        const table = bids
          .map((b) => {
            const r = reputations[b.agent] || { ratingAvg: 0, jobs: 0 };
            return `- ${b.agent}: ${b.priceNEAR} NEAR, ETA ${b.etaSec}s, rating ${r.ratingAvg}/5 over ${r.jobs} jobs. Pitch: ${b.pitch}`;
          })
          .join('\n');
        const out = await chat(
          'You are a hiring agent with a strict budget. Pick the best value bid, weighing price, ETA and on-chain reputation. Reply with ONLY JSON: {"agent": "<account id>", "reason": string <= 140 chars}.',
          `Task: "${task.title}"\nBids:\n${table}`
        );
        const j = extractJson(out);
        const found = bids.find((b) => b.agent === j.agent);
        log(`   🤝 Hiring rationale: ${j.reason || 'n/a'}`);
        return found ? found.agent : bids[0].agent;
      } catch (e) {
        log(`   ⚠️  LLM choice failed (${e.message}), picking cheapest`);
        return bids.slice().sort((a, b) => a.priceNEAR - b.priceNEAR)[0].agent;
      }
    },

    /** Poster verifies and grades the deliverable. Returns 1-5. */
    async gradeWork(task, resultMarkdown, personality) {
      if (!hasKey) return personality ? personality.quality : 4;
      try {
        const out = await chat(
          'You are a strict client. Grade the deliverable against the spec. Reply with ONLY JSON: {"rating": 1-5, "feedback": string <= 140 chars}.',
          `Task: "${task.title}"\nSpec: ${task.spec}\n\nDeliverable:\n${resultMarkdown.slice(0, 3000)}`
        );
        const j = extractJson(out);
        log(`   ⭐ Client feedback: ${j.feedback || 'n/a'}`);
        return Math.min(5, Math.max(1, Number(j.rating) || 4));
      } catch {
        return 4;
      }
    },
  };
}

module.exports = { makeLlm };
