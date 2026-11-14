// Laporan keputusan scan Auto Entry (murni, tanpa I/O): detail alasan per kandidat, baris log funnel,
// dan ringkasan (digest) Telegram berkala.
const f1 = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "?");
const f2 = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : "?");

// Funnel kosong untuk satu scan strategi.
export function emptyFunnel() {
  return { fetched: 0, filtered: {}, passed: 0, tokens: 0, limited: {}, checked: 0, error: null };
}

export function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

const sumCounts = (counts) => Object.values(counts).reduce((s, n) => s + n, 0);

// "fee_tvl 30, tvl 12" — terbanyak dulu.
export function fmtCounts(counts, { sep = ", " } = {}) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(sep);
}

export function tokenDetail(reason, token, p, now) {
  const audit = token?.audit ?? {};
  if (reason === "no_token") return "no Jupiter token info";
  if (reason === "mcap") return `Jupiter mcap $${Math.round(Number(token?.mcap) || 0)} outside ${p.minMcapUsd}–${p.maxMcapUsd || "∞"}`;
  if (reason === "holders") return `Jupiter holders ${token?.holderCount ?? "?"} < ${p.minHolders}`;
  if (reason === "top10") return `top 10 holders ${f1(audit.topHoldersPercentage)} > ${p.maxTop10Pct}%`;
  if (reason === "age") {
    const created = Date.parse(token?.createdAt ?? token?.firstPool?.createdAt ?? "");
    const age = Number.isFinite(created) ? `${((now - created) / 3600000).toFixed(1)}h` : "?";
    return `token age ${age} outside ${p.minTokenAgeH}–${p.maxTokenAgeH || "∞"}h`;
  }
  if (reason === "authorities") return "mint/freeze authority not disabled";
  return reason;
}

const px = (v) => (Number.isFinite(v) ? `$${v.toPrecision(4)}` : "?");

export function signalDetail(sig, p, source) {
  const m = sig.metrics;
  if (sig.reason === "no_history") return "no ATH/ATL (not enough candles)";
  if (!m) return sig.reason;
  const fib = `price ${px(m.price)} · fib ${p.fibEntryLevel} ${px(m.fibEntry)} · ATL ${px(m.atl)} / ATH ${px(m.ath)}`;
  const src = source ? ` · 5m ${source}` : "";
  if (sig.reason === "above_fib") return `${fib} → price above fib ${p.fibEntryLevel}${src}`;
  if (sig.reason === "signal") return `${fib} · max range ${f1(m.maxPct)} (to fib ${p.fibDeepLevel})${src}`;
  return sig.reason;
}

export function limitDetail(reason, p) {
  if (reason === "max_open") return `strategy already has ${p.maxOpen} open trade(s)`;
  if (reason === "token_open") return "token already has an open auto trade";
  if (reason === "cooldown") return "token in cooldown after its last close";
  if (reason === "profile_off") return "strategy off";
  return reason;
}

// Baris log funnel satu scan strategi.
export function funnelLine(name, f) {
  if (f.error) return `Auto entry ${name} scan: ${f.error}`;
  const parts = [`${f.fetched} pools`];
  const dropped = sumCounts(f.filtered);
  parts.push(dropped ? `filters −${dropped} (${fmtCounts(f.filtered)})` : "filters −0");
  parts.push(`${f.passed} pass`, `${f.tokens} tokens`);
  const limited = sumCounts(f.limited);
  parts.push(limited ? `limits −${limited} (${fmtCounts(f.limited)})` : "limits −0");
  parts.push(`${f.checked} checked`);
  return `Auto entry ${name} scan: ${parts.join(" → ")}`;
}

// Baris log satu kandidat: verdict + alasan.
export function candidateLine(name, c) {
  const pair = c.pairName || `${c.pool.slice(0, 8)}…`;
  const extra = [`fee/active TVL ${f2(c.feeActiveTvl30mPct)}`];
  if (Number.isFinite(c.volatilityPct)) extra.push(`vol ${c.volatilityPct.toFixed(1)}`);
  return `Auto entry ${name} · ${pair} → ${c.signal}${c.detail ? ` (${c.detail})` : ""} · ${extra.join(" · ")}`;
}

// Digest: akumulasi scan per strategi sejak digest terakhir.
export function emptyDigest() {
  return { profiles: {} };
}

export function addScan(digest, name, funnel, candidates) {
  const d = (digest.profiles[name] ??= {
    scans: 0,
    errors: 0,
    fetched: 0,
    passed: 0,
    tokens: 0,
    checked: 0,
    verdicts: {},
    lastErrors: [],
    latest: [],
  });
  d.scans++;
  if (funnel.error) {
    d.errors++;
    d.lastErrors = [...d.lastErrors, funnel.error].slice(-3);
    return;
  }
  d.fetched += funnel.fetched;
  d.passed += funnel.passed;
  d.tokens += funnel.tokens;
  d.checked += funnel.checked;
  for (const c of candidates) bump(d.verdicts, c.signal || "?");
  d.latest = candidates.map((c) => ({ pairName: c.pairName, pool: c.pool, signal: c.signal, detail: c.detail }));
}

const avg = (sum, n) => (n > 0 ? Math.round(sum / n) : 0);

// minutes null = digest pertama (setelah scan pertama).
export function buildDigestText(digest, { mode, minutes, profilesOn = [] }) {
  const span = minutes == null ? "first scan" : `last ${Math.round(minutes)}m`;
  const L = [`🔎 Auto Entry digest · ${span} · ${mode}`];
  const names = [...new Set([...profilesOn, ...Object.keys(digest.profiles)])];
  if (names.length === 0) L.push("", "No strategy is on.");
  for (const name of names) {
    const d = digest.profiles[name];
    L.push("");
    if (!d) {
      L.push(`${name} — no scan yet`);
      continue;
    }
    L.push(`${name} — ${d.scans} scan(s)${d.errors ? `, ${d.errors} error(s)` : ""}`);
    const ok = d.scans - d.errors;
    if (ok > 0) {
      L.push(
        `  avg/scan: ${avg(d.fetched, ok)} pools → ${avg(d.passed, ok)} pass → ${avg(d.tokens, ok)} tokens → ${avg(d.checked, ok)} checked`
      );
      L.push(`  verdicts: ${fmtCounts(d.verdicts, { sep: " · " }) || "none (no candidate reached the checks)"}`);
    }
    if (d.lastErrors.length) L.push(`  last error: ${d.lastErrors[d.lastErrors.length - 1]}`);
    if (d.latest.length) {
      L.push("  latest scan:");
      for (const c of d.latest) {
        const pair = c.pairName || `${c.pool.slice(0, 8)}…`;
        L.push(`  • ${pair} — ${c.signal}${c.detail ? `: ${c.detail}` : ""}`);
      }
    }
  }
  return L.join("\n");
}
