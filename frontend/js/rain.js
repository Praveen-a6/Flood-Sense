// Offline rain-description parser.
// Understands numbers ("12 cm in 2 days", "40 mm"), plain words
// ("poured heavily for 3 hours, then drizzled 2 hours"), a bit of Tamil
// (கனமழை 3 மணி நேரம்) and Tanglish ("romba mazhai 2 mani neram").
// Clauses are read in order: the LAST clause is the most recent rain.

// Approximate rain rates (mm per hour) for words people actually use.
export const INTENSITY = [
  { mmh: 100, label: "cloudburst", words: ["cloudburst", "cloud burst", "மேகவெடிப்பு"] },
  { mmh: 40, label: "very heavy", words: ["very heavy", "very heavily", "extremely heavy", "torrential", "like hell", "romba romba", "அடைமழை", "பெருமழை", "மிக கனமழை"] },
  { mmh: 20, label: "heavy", words: ["heavy", "heavily", "pouring", "poured", "pour", "downpour", "lashing", "lashed", "bucketing", "thunderstorm", "storm", "romba mazhai", "periya mazhai", "கனமழை", "கனத்த மழை", "பலத்த மழை"] },
  { mmh: 6.5, label: "moderate", words: ["moderate", "moderately", "steady", "steadily", "normal rain", "proper rain", "மிதமான"] },
  { mmh: 2.5, label: "light", words: ["light", "lightly", "slight", "little rain", "konjam mazhai", "showers", "shower", "லேசான", "சிறிய மழை"] },
  { mmh: 1.0, label: "drizzle", words: ["drizzle", "drizzled", "drizzling", "sprinkle", "sprinkled", "saaral", "thooral", "தூறல்", "சாரல்"] },
];

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, few: 3, couple: 2, several: 4, half: 0.5, onnu: 1, rendu: 2, moonu: 3, naalu: 4, anju: 5 };

const DURATION_PHRASES = [
  [/whole night|all night|overnight|full night|night full|இரவு முழுவதும்/, 8],
  [/whole day|all day|full day|day full|since morning|நாள் முழுவதும்/, 10],
  [/since yesterday|from yesterday/, 24],
  [/past few days|last few days|few days/, 72],
  [/half an hour|half hour|அரை மணி/, 0.5],
];

function num(tok) {
  if (tok == null) return null;
  const n = parseFloat(tok);
  if (!Number.isNaN(n)) return n;
  return NUM_WORDS[tok] ?? null;
}

// generic "it rained" words count as moderate, but only if nothing more specific matched
const GENERIC = { mmh: 6.5, label: "moderate", words: ["rained", "raining", "rain", "mazhai", "மழை"] };

function findIntensity(t) {
  for (const lvl of INTENSITY) for (const w of lvl.words) if (t.includes(w)) return lvl;
  for (const w of GENERIC.words) if (t.includes(w)) return GENERIC;
  return null;
}

function findDurationHours(t) {
  const m = t.match(/(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|few|couple|several|half|onnu|rendu|moonu|naalu|anju)\s*(?:of\s+)?(minutes?|mins?|hours?|hrs?|h\b|days?|nights?|weeks?|mani(?:\s*neram)?|மணி(?:\s*நேரம்)?|நாட்கள்|நாள்|naal)/);
  if (m) {
    const n = num(m[1]) ?? 1;
    const u = m[2];
    if (/^min/.test(u)) return n / 60;
    if (/^(day|night|நாள்|நாட்கள்|naal)/.test(u)) return n * 24;
    if (/^week/.test(u)) return n * 168;
    return n;
  }
  for (const [re, h] of DURATION_PHRASES) if (re.test(t)) return h;
  return null;
}

function findAmountMm(t) {
  const m = t.match(/(\d+(?:\.\d+)?)\s*(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|inch(?:es)?|in\b|"|மிமீ|செமீ)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = m[2];
  if (/^(cm|cent|செமீ)/.test(u)) return v * 10;
  if (/^(inch|in|")/.test(u)) return v * 25.4;
  return v;
}

/**
 * parseRain("poured heavily for 3 hours, then drizzled 2 hours")
 * -> { ok, events:[{mm, hours, label}], features:{rain_1h,...}, summary, notes:[] }
 */
export function parseRain(text) {
  const notes = [];
  const t0 = (text || "").toLowerCase().trim();
  if (!t0) return { ok: false, events: [], features: zeroFeatures(), summary: "No rain entered", notes };
  const reservoir = /(dam|reservoir|lake|eri|ஏரி|அணை).{0,30}(open|release|releas|surplus|overflow|gate|full)|(open|release|releas|surplus).{0,30}(dam|reservoir|lake|eri)/.test(t0);
  const still = /(still|continu|not stopped|hasn'?t stopped|ongoing|right now|இன்னும்)/.test(t0);

  const clauses = t0.split(/,|;|\.\s|\bthen\b|\band then\b|\bafter that\b|\bfollowed by\b|\bafterwards\b|\blater\b|\bபிறகு\b|\bapram\b|\baprom\b/)
    .map((s) => s.trim()).filter(Boolean);

  const events = [];
  for (const c of clauses) {
    if (/(stopped|no rain|dry since|been dry|clear since|நின்று)/.test(c)) {
      const h = findDurationHours(c);
      if (h) events.push({ mm: 0, hours: h, label: "no rain" });
      continue;
    }
    const amount = findAmountMm(c);
    let hours = findDurationHours(c);
    const lvl = findIntensity(c);
    if (amount != null) {
      if (hours == null) { hours = 24; notes.push(`"${c}": no duration given, assumed it fell over 24 h`); }
      events.push({ mm: amount, hours, label: `${amount.toFixed(0)} mm` });
    } else if (lvl) {
      if (hours == null) { hours = 1; notes.push(`"${c}": no duration given, assumed 1 hour`); }
      // very long spells of "heavy" rain rarely keep the peak rate: taper after 6 h, cap at 500 mm
      const mm = Math.min(500, lvl.mmh * Math.min(hours, 6) + lvl.mmh * Math.max(0, hours - 6) * (lvl.mmh >= 20 ? 0.4 : 1));
      events.push({ mm, hours, label: lvl.label, mmh: lvl.mmh });
    } else if (hours != null && /rain|mazhai|மழை|pour|shower/.test(c)) {
      events.push({ mm: 6.5 * hours, hours, label: "moderate", mmh: 6.5 });
    }
  }
  if (!events.length) {
    return { ok: false, events, features: zeroFeatures(), summary: "Couldn't understand that. Try: \"heavy rain for 3 hours\" or \"12 cm in 2 days\"", notes };
  }

  // timeline: hourly mm for the last 72 h, most recent last
  const hourly = new Array(72).fill(0);
  let pos = 72; // fill backwards from now
  for (let e = events.length - 1; e >= 0 && pos > 0; e--) {
    const ev = events[e];
    const rate = ev.hours > 0 ? ev.mm / ev.hours : 0;
    let left = ev.hours;
    while (left > 1e-9 && pos > 0) {
      const take = Math.min(1, left);
      hourly[pos - 1] += rate * take;
      left -= take;
      if (take >= 1 || left <= 1e-9) pos--;
    }
  }
  const sum = (h) => hourly.slice(72 - h).reduce((a, b) => a + b, 0);
  const last = events[events.length - 1];
  const fc = still && last.mm > 0 ? (last.mm / last.hours) * 3 * 0.6 : 0;
  if (still) notes.push("Rain still falling: added a 3-hour forecast at a lower rate");
  if (reservoir) notes.push("Reservoir release detected: low ground near rivers/lakes gets extra risk");
  const features = {
    rain_1h: round(sum(1)), rain_3h: round(sum(3)), rain_24h: round(sum(24)), rain_72h: round(sum(72)),
    rain_fc_3h: round(fc), reservoir_release: reservoir ? 1 : 0,
  };
  const total = events.reduce((a, e) => a + e.mm, 0);
  const summary = `≈ ${round(total)} mm total · last 3 h ${features.rain_3h} mm · last 24 h ${features.rain_24h} mm`;
  return { ok: true, events, features, summary, notes };
}

export function zeroFeatures() {
  return { rain_1h: 0, rain_3h: 0, rain_24h: 0, rain_72h: 0, rain_fc_3h: 0, reservoir_release: 0 };
}

function round(v) { return Math.round(v * 10) / 10; }
