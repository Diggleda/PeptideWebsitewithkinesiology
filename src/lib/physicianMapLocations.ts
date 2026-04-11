export type MapLocationPrecision = "area" | "city" | "state" | "unknown";

type KnownPlaceEntry = {
  aliases: string[];
  coordinates: [number, number];
  stateCodes?: string[];
};

const GENERIC_LOCATION_TERMS = new Set([
  "greater",
  "area",
  "metro",
  "metropolitan",
  "region",
  "county",
  "counties",
  "surrounding",
  "surroundingarea",
  "surroundingareas",
  "suburb",
  "suburbs",
  "market",
  "corridor",
  "district",
  "the",
]);

const KNOWN_PLACE_ENTRIES: KnownPlaceEntry[] = [
  { aliases: ["new york", "new york city", "nyc", "manhattan", "brooklyn", "queens"], coordinates: [-74.006, 40.7128], stateCodes: ["NY", "NJ", "CT"] },
  { aliases: ["north jersey", "northern new jersey", "newark"], coordinates: [-74.1724, 40.7357], stateCodes: ["NJ"] },
  { aliases: ["philadelphia", "greater philadelphia", "main line"], coordinates: [-75.1652, 39.9526], stateCodes: ["PA", "NJ", "DE"] },
  { aliases: ["pittsburgh"], coordinates: [-79.9959, 40.4406], stateCodes: ["PA"] },
  { aliases: ["boston", "greater boston"], coordinates: [-71.0589, 42.3601], stateCodes: ["MA", "NH", "RI"] },
  { aliases: ["providence"], coordinates: [-71.4128, 41.824], stateCodes: ["RI", "MA"] },
  { aliases: ["hartford"], coordinates: [-72.6734, 41.7658], stateCodes: ["CT"] },
  { aliases: ["albany"], coordinates: [-73.7562, 42.6526], stateCodes: ["NY"] },
  { aliases: ["buffalo"], coordinates: [-78.8784, 42.8864], stateCodes: ["NY"] },
  { aliases: ["rochester"], coordinates: [-77.6109, 43.1566], stateCodes: ["NY"] },
  { aliases: ["syracuse"], coordinates: [-76.1474, 43.0481], stateCodes: ["NY"] },
  { aliases: ["washington", "washington dc", "dc", "dmv"], coordinates: [-77.0369, 38.9072], stateCodes: ["DC", "MD", "VA"] },
  { aliases: ["northern virginia", "nova"], coordinates: [-77.1773, 38.8048], stateCodes: ["VA"] },
  { aliases: ["baltimore"], coordinates: [-76.6122, 39.2904], stateCodes: ["MD"] },
  { aliases: ["richmond"], coordinates: [-77.436, 37.5407], stateCodes: ["VA"] },
  { aliases: ["hampton roads", "norfolk", "virginia beach", "tidewater"], coordinates: [-76.2859, 36.8508], stateCodes: ["VA"] },
  { aliases: ["charlotte"], coordinates: [-80.8431, 35.2271], stateCodes: ["NC", "SC"] },
  { aliases: ["raleigh", "durham", "chapel hill", "raleigh durham", "triangle", "research triangle"], coordinates: [-78.6382, 35.7796], stateCodes: ["NC"] },
  { aliases: ["greenville"], coordinates: [-82.394, 34.8526], stateCodes: ["SC"] },
  { aliases: ["charleston"], coordinates: [-79.9311, 32.7765], stateCodes: ["SC"] },
  { aliases: ["atlanta", "metro atlanta"], coordinates: [-84.388, 33.749], stateCodes: ["GA"] },
  { aliases: ["miami", "greater miami"], coordinates: [-80.1918, 25.7617], stateCodes: ["FL"] },
  { aliases: ["south florida", "fort lauderdale", "ft lauderdale", "broward"], coordinates: [-80.1373, 26.1224], stateCodes: ["FL"] },
  { aliases: ["west palm beach", "palm beach", "boca raton"], coordinates: [-80.0534, 26.7153], stateCodes: ["FL"] },
  { aliases: ["orlando", "central florida"], coordinates: [-81.3792, 28.5383], stateCodes: ["FL"] },
  { aliases: ["tampa", "tampa bay", "st petersburg", "clearwater"], coordinates: [-82.4572, 27.9506], stateCodes: ["FL"] },
  { aliases: ["jacksonville", "northeast florida"], coordinates: [-81.6557, 30.3322], stateCodes: ["FL"] },
  { aliases: ["naples"], coordinates: [-81.7948, 26.142], stateCodes: ["FL"] },
  { aliases: ["fort myers", "ft myers", "sw florida", "southwest florida"], coordinates: [-81.8723, 26.6406], stateCodes: ["FL"] },
  { aliases: ["sarasota"], coordinates: [-82.5307, 27.3364], stateCodes: ["FL"] },
  { aliases: ["birmingham"], coordinates: [-86.8104, 33.5186], stateCodes: ["AL"] },
  { aliases: ["nashville"], coordinates: [-86.7816, 36.1627], stateCodes: ["TN"] },
  { aliases: ["memphis"], coordinates: [-90.049, 35.1495], stateCodes: ["TN"] },
  { aliases: ["new orleans"], coordinates: [-90.0715, 29.9511], stateCodes: ["LA"] },
  { aliases: ["chicago", "chicagoland"], coordinates: [-87.6298, 41.8781], stateCodes: ["IL", "IN", "WI"] },
  { aliases: ["indianapolis"], coordinates: [-86.1581, 39.7684], stateCodes: ["IN"] },
  { aliases: ["detroit", "metro detroit"], coordinates: [-83.0458, 42.3314], stateCodes: ["MI"] },
  { aliases: ["cleveland"], coordinates: [-81.6944, 41.4993], stateCodes: ["OH"] },
  { aliases: ["columbus"], coordinates: [-82.9988, 39.9612], stateCodes: ["OH"] },
  { aliases: ["cincinnati"], coordinates: [-84.512, 39.1031], stateCodes: ["OH", "KY", "IN"] },
  { aliases: ["louisville"], coordinates: [-85.7585, 38.2527], stateCodes: ["KY", "IN"] },
  { aliases: ["lexington"], coordinates: [-84.5037, 38.0406], stateCodes: ["KY"] },
  { aliases: ["milwaukee"], coordinates: [-87.9065, 43.0389], stateCodes: ["WI"] },
  { aliases: ["minneapolis", "st paul", "twin cities"], coordinates: [-93.265, 44.9778], stateCodes: ["MN"] },
  { aliases: ["st louis", "saint louis"], coordinates: [-90.1994, 38.627], stateCodes: ["MO", "IL"] },
  { aliases: ["kansas city"], coordinates: [-94.5786, 39.0997], stateCodes: ["MO", "KS"] },
  { aliases: ["omaha"], coordinates: [-95.998, 41.2565], stateCodes: ["NE", "IA"] },
  { aliases: ["des moines"], coordinates: [-93.625, 41.5868], stateCodes: ["IA"] },
  { aliases: ["dallas", "fort worth", "ft worth", "dallas fort worth", "dfw", "metroplex"], coordinates: [-96.797, 32.7767], stateCodes: ["TX"] },
  { aliases: ["houston"], coordinates: [-95.3698, 29.7604], stateCodes: ["TX"] },
  { aliases: ["austin"], coordinates: [-97.7431, 30.2672], stateCodes: ["TX"] },
  { aliases: ["san antonio"], coordinates: [-98.4936, 29.4241], stateCodes: ["TX"] },
  { aliases: ["oklahoma city"], coordinates: [-97.5164, 35.4676], stateCodes: ["OK"] },
  { aliases: ["tulsa"], coordinates: [-95.9928, 36.154], stateCodes: ["OK"] },
  { aliases: ["denver", "front range"], coordinates: [-104.9903, 39.7392], stateCodes: ["CO"] },
  { aliases: ["phoenix", "greater phoenix", "scottsdale", "east valley", "west valley"], coordinates: [-112.074, 33.4484], stateCodes: ["AZ"] },
  { aliases: ["tucson"], coordinates: [-110.9747, 32.2226], stateCodes: ["AZ"] },
  { aliases: ["salt lake city", "slc"], coordinates: [-111.891, 40.7608], stateCodes: ["UT"] },
  { aliases: ["las vegas"], coordinates: [-115.1398, 36.1699], stateCodes: ["NV"] },
  { aliases: ["albuquerque"], coordinates: [-106.6504, 35.0844], stateCodes: ["NM"] },
  { aliases: ["boise"], coordinates: [-116.2023, 43.615], stateCodes: ["ID"] },
  { aliases: ["seattle", "puget sound", "bellevue", "tacoma"], coordinates: [-122.3321, 47.6062], stateCodes: ["WA"] },
  { aliases: ["spokane"], coordinates: [-117.426, 47.6588], stateCodes: ["WA"] },
  { aliases: ["portland"], coordinates: [-122.6784, 45.5152], stateCodes: ["OR"] },
  { aliases: ["san francisco", "bay area", "sf bay", "east bay", "oakland"], coordinates: [-122.4194, 37.7749], stateCodes: ["CA"] },
  { aliases: ["san jose", "silicon valley", "south bay"], coordinates: [-121.8863, 37.3382], stateCodes: ["CA"] },
  { aliases: ["sacramento"], coordinates: [-121.4944, 38.5816], stateCodes: ["CA"] },
  { aliases: ["fresno"], coordinates: [-119.7871, 36.7378], stateCodes: ["CA"] },
  { aliases: ["los angeles", "greater los angeles", "la"], coordinates: [-118.2437, 34.0522], stateCodes: ["CA"] },
  { aliases: ["orange county", "anaheim", "irvine", "newport beach"], coordinates: [-117.9143, 33.8366], stateCodes: ["CA"] },
  { aliases: ["inland empire", "riverside", "san bernardino"], coordinates: [-117.3961, 33.9533], stateCodes: ["CA"] },
  { aliases: ["san diego"], coordinates: [-117.1611, 32.7157], stateCodes: ["CA"] },
  { aliases: ["honolulu"], coordinates: [-157.8583, 21.3069], stateCodes: ["HI"] },
  { aliases: ["anchorage"], coordinates: [-149.9003, 61.2181], stateCodes: ["AK"] },
];

type CandidateValue = {
  precision: Exclude<MapLocationPrecision, "state" | "unknown">;
  value: string | null | undefined;
};

const normalizeLocationKey = (value?: string | null) => {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !GENERIC_LOCATION_TERMS.has(token))
    .join(" ");
};

const getAliasScore = (input: string, alias: string) => {
  if (!input || !alias) {
    return 0;
  }
  if (input === alias) {
    return 120 + alias.length;
  }
  if (input.length <= 3 || alias.length <= 3) {
    return 0;
  }

  const inputTokens = input.split(" ");
  const aliasTokens = alias.split(" ");

  if (aliasTokens.every((token) => inputTokens.includes(token))) {
    return 90 + (aliasTokens.length * 6);
  }
  if (inputTokens.every((token) => aliasTokens.includes(token))) {
    return 82 + (inputTokens.length * 5);
  }
  if (input.includes(alias) || alias.includes(input)) {
    return 66 + (Math.min(aliasTokens.length, inputTokens.length) * 4);
  }

  return 0;
};

const findBestKnownPlace = (value: string, stateCode?: string | null) => {
  const normalizedInput = normalizeLocationKey(value);
  if (!normalizedInput) {
    return null;
  }

  let bestMatch: { coordinates: [number, number]; score: number } | null = null;

  KNOWN_PLACE_ENTRIES.forEach((entry) => {
    const stateMatches = !entry.stateCodes || !stateCode || entry.stateCodes.includes(stateCode);
    if (entry.stateCodes && stateCode && !stateMatches) {
      return;
    }
    entry.aliases.forEach((alias) => {
      const score = getAliasScore(normalizedInput, normalizeLocationKey(alias));
      if (!score) {
        return;
      }
      const nextScore = score + (stateMatches ? 12 : 0);
      if (!bestMatch || nextScore > bestMatch.score) {
        bestMatch = {
          coordinates: entry.coordinates,
          score: nextScore,
        };
      }
    });
  });

  return bestMatch?.score ? bestMatch : null;
};

export const resolveApproximateUsPlaceCoordinates = ({
  greaterArea,
  officeCity,
  stateCode,
  fallbackCoordinates,
}: {
  greaterArea?: string | null;
  officeCity?: string | null;
  stateCode?: string | null;
  fallbackCoordinates?: [number, number] | null;
}): { coordinates: [number, number] | null; precision: MapLocationPrecision } => {
  const candidates: CandidateValue[] = [
    { precision: "area", value: greaterArea },
    { precision: "city", value: officeCity },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }
    const match = findBestKnownPlace(candidate.value, stateCode);
    if (match) {
      return {
        coordinates: match.coordinates,
        precision: candidate.precision,
      };
    }
  }

  if (fallbackCoordinates) {
    return {
      coordinates: fallbackCoordinates,
      precision: "state",
    };
  }

  return {
    coordinates: null,
    precision: "unknown",
  };
};
