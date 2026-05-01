export const US_STATE_ABBR: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana",
  IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};

// Genuine AP-style abbreviations that fuzzy matching cannot reach. These are
// short (<6 chars) so Levenshtein-based catches don't apply, and they're real
// abbreviations rather than typos. Misspellings are deliberately NOT listed
// here - the fuzzy fallback in detectState catches them generically.
const US_STATE_EXTRA: Record<string, string> = {
  "ala": "AL", "ariz": "AZ", "ark": "AR", "calif": "CA", "cal": "CA",
  "colo": "CO", "conn": "CT", "del": "DE", "fla": "FL", "ill": "IL",
  "ind": "IN", "kan": "KS", "kans": "KS", "mass": "MA",
  "mich": "MI", "minn": "MN", "miss": "MS", "mont": "MT",
  "neb": "NE", "nebr": "NE", "nev": "NV", "okla": "OK", "ore": "OR",
  "oreg": "OR", "penn": "PA", "penna": "PA", "tenn": "TN", "tex": "TX",
  "wash": "WA", "wis": "WI", "wisc": "WI", "wyo": "WY",
  "n h": "NH", "n j": "NJ", "n m": "NM", "n mex": "NM", "n y": "NY",
  "n c": "NC", "n d": "ND", "n dak": "ND", "r i": "RI", "s c": "SC",
  "s d": "SD", "s dak": "SD", "w va": "WV", "d c": "DC",
};

export const US_NAME_TO_ABBR: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [abbr, name] of Object.entries(US_STATE_ABBR)) m[name.toLowerCase()] = abbr;
  for (const [slug, abbr] of Object.entries(US_STATE_EXTRA)) m[slug] = abbr;
  m["d.c."] = "DC";
  m["washington d.c."] = "DC";
  m["washington, d.c."] = "DC";
  return m;
})();

export const CA_PROVINCES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba",
  NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia",
  NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario",
  PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};

export const CA_PROV_NAME: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [abbr, name] of Object.entries(CA_PROVINCES)) m[name.toLowerCase()] = abbr;
  return m;
})();

export const COUNTRY_ALIASES: Record<string, string> = {
  "usa": "US", "u.s.a.": "US", "u.s.": "US", "united states": "US",
  "united states of america": "US", "us": "US", "america": "US",
  "uk": "GB", "u.k.": "GB", "england": "GB", "scotland": "GB",
  "wales": "GB", "great britain": "GB", "britain": "GB",
  "united kingdom": "GB", "northern ireland": "GB",
  "canada": "CA",
  "ireland": "IE",
  "germany": "DE", "deutschland": "DE", "prussia": "DE",
  "france": "FR", "italy": "IT", "spain": "ES", "portugal": "PT",
  "netherlands": "NL", "holland": "NL", "belgium": "BE",
  "switzerland": "CH", "austria": "AT", "poland": "PL", "russia": "RU",
  "ukraine": "UA", "sweden": "SE", "norway": "NO", "denmark": "DK",
  "finland": "FI", "australia": "AU", "new zealand": "NZ",
  "south africa": "ZA", "mexico": "MX", "brazil": "BR",
  "japan": "JP", "china": "CN", "india": "IN",
  "czechoslovakia": "CZ", "yugoslavia": "RS", "bohemia": "CZ",
  "moravia": "CZ", "prussia, germany": "DE",
  "hungary": "HU", "greece": "GR", "romania": "RO",
  "lithuania": "LT", "latvia": "LV", "estonia": "EE",
};

export const US_REGIONS: Record<string, Set<string>> = {
  South: new Set(["AL","AR","FL","GA","KY","LA","MS","NC","OK","SC","TN","TX","VA","WV","DC","MD","DE"]),
  Northeast: new Set(["CT","ME","MA","NH","NJ","NY","PA","RI","VT"]),
  Midwest: new Set(["IL","IN","IA","KS","MI","MN","MO","NE","ND","OH","SD","WI"]),
  West: new Set(["AK","AZ","CA","CO","HI","ID","MT","NV","NM","OR","UT","WA","WY"]),
};

export const STATE_TO_REGION: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [region, sts] of Object.entries(US_REGIONS)) {
    for (const st of sts) m[st] = region;
  }
  return m;
})();
