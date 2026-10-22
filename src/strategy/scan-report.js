// Laporan keputusan scan Auto Entry (murni, tanpa I/O): detail alasan per kandidat, baris log funnel,
// dan ringkasan (digest) Telegram berkala.
const f1 = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "?");
const f2 = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : "?");

// Funnel kosong untuk satu scan profil.
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

export function tokenDetail(reason, token, g) {
  const audit = token?.audit ?? {};
  if (reason === "no_token") return "no Jupiter token info";
  if (reason === "organic") return `organic score ${token?.organicScore ?? "?"} < ${g.organicScoreMin}`;
  if (reason === "top_holders") return `top holders ${audit.topHoldersPercentage ?? "?"}% > ${g.topHoldersMaxPct}%`;
  if (reason === "authorities") return "mint/freeze authority not disabled";
  return reason;
}

export function volatilityDetail(vol, p) {
  if (vol == null) return "volatility n/a (not enough closed 5m bars)";
  return `volatility ${f1(vol)} outside ${p.volatilityMinPct}–${p.volatilityMaxPct}%`;
}

export function signalDetail(sig, p) {
  const m = sig.metrics;
  if (sig.reason === "immediate") return "immediate timing";
  if (sig.reason === "not_enough_bars") return `not enough closed 5m bars for ${p.pumpLookbackMin}m lookback`;
  if (!m) return sig.reason;
  const pump = `pump ${f1(m.pumpPct)}`;
  const pull = `pullback ${f1(m.pullbackPct)}`;
  if (sig.reason === "no_pump") return `${pump} < min ${p.minPumpPct}% in ${p.pumpLookbackMin}m`;
  if (sig.reason === "pullback_small") return `${pump} · ${pull} < min ${p.minPullbackPct}%`;
  if (sig.reason === "pullback_large") return `${pump} · ${pull} > max ${p.maxPullbackPct}%`;
  if (sig.reason === "not_red") return `${pump} · ${pull} · last bar not red`;
  if (sig.reason === "signal") return `${pump} · ${pull} · last bar red`;
  return sig.reason;
}

export function limitDetail(reason, p) {
  if (reason === "max_open") return `profile already has ${p.maxOpen} open trade(s)`;
  if (reason === "token_open") return "token already has an open auto trade";
  if (reason === "cooldown") return "token in cooldown after its last close";
  if (reason === "profile_off") return "profile off";
  return reason;
}

// Baris log funnel satu scan profil.
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
  const extra = [`fee/TVL ${f2(c.feeTvl30mPct)}`];
  if (c.volatilityPct != null) extra.push(`vol ${f1(c.volatilityPct)}`);
  return `Auto entry ${name} · ${pair} → ${c.signal}${c.detail ? ` (${c.detail})` : ""} · ${extra.join(" · ")}`;
}

// Digest: akumulasi scan per profil sejak digest terakhir.
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
  if (names.length === 0) L.push("", "No profile is on.");
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
