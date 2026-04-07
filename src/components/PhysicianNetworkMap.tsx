import { useEffect, useMemo, useState } from "react";
import { geoCentroid } from "d3-geo";
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
} from "react-simple-maps";
import usStatesTopologyUrl from "us-atlas/states-10m.json?url";
import { settingsAPI } from "../services/api";

type NetworkDoctorRecord = {
  id: string;
  name?: string | null;
  profileImageUrl?: string | null;
  greaterArea?: string | null;
  studyFocus?: string | null;
  bio?: string | null;
  officeCity?: string | null;
  officeState?: string | null;
};

type NormalizedDoctor = NetworkDoctorRecord & {
  displayName: string;
  stateCode: string | null;
  locationLabel: string | null;
};

type MarkerEntry = {
  doctor: NormalizedDoctor;
  coordinates: [number, number];
  stackSize: number;
};

const BRAND_BLUE = "rgb(95, 179, 249)";

const STATE_NAME_BY_CODE: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

const STATE_CODE_BY_FIPS: Record<string, string> = {
  "01": "AL",
  "02": "AK",
  "04": "AZ",
  "05": "AR",
  "06": "CA",
  "08": "CO",
  "09": "CT",
  "10": "DE",
  "11": "DC",
  "12": "FL",
  "13": "GA",
  "15": "HI",
  "16": "ID",
  "17": "IL",
  "18": "IN",
  "19": "IA",
  "20": "KS",
  "21": "KY",
  "22": "LA",
  "23": "ME",
  "24": "MD",
  "25": "MA",
  "26": "MI",
  "27": "MN",
  "28": "MS",
  "29": "MO",
  "30": "MT",
  "31": "NE",
  "32": "NV",
  "33": "NH",
  "34": "NJ",
  "35": "NM",
  "36": "NY",
  "37": "NC",
  "38": "ND",
  "39": "OH",
  "40": "OK",
  "41": "OR",
  "42": "PA",
  "44": "RI",
  "45": "SC",
  "46": "SD",
  "47": "TN",
  "48": "TX",
  "49": "UT",
  "50": "VT",
  "51": "VA",
  "53": "WA",
  "54": "WV",
  "55": "WI",
  "56": "WY",
};

const STATE_CODE_LOOKUP = Object.entries(STATE_NAME_BY_CODE).reduce<Record<string, string>>(
  (lookup, [code, name]) => {
    lookup[code.toLowerCase()] = code;
    lookup[name.toLowerCase()] = code;
    return lookup;
  },
  {},
);

const normalizeStateCode = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase().replace(/\./g, "");
  return STATE_CODE_LOOKUP[normalized] || null;
};

const normalizeText = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const buildLocationLabel = (doctor: {
  officeCity?: string | null;
  greaterArea?: string | null;
  stateCode?: string | null;
}) => {
  const city = normalizeText(doctor.officeCity);
  const area = normalizeText(doctor.greaterArea);
  const stateCode = normalizeText(doctor.stateCode);

  if (city && stateCode) {
    return `${city}, ${stateCode}`;
  }
  if (area && stateCode) {
    return `${area}, ${stateCode}`;
  }
  if (city) {
    return city;
  }
  if (area) {
    return area;
  }
  if (stateCode) {
    return STATE_NAME_BY_CODE[stateCode] || stateCode;
  }
  return null;
};

const buildMarkerEntries = (
  doctorsByState: Map<string, NormalizedDoctor[]>,
  stateCenters: Map<string, [number, number]>,
): MarkerEntry[] => {
  const entries: MarkerEntry[] = [];

  doctorsByState.forEach((doctors, stateCode) => {
    const center = stateCenters.get(stateCode);
    if (!center) {
      return;
    }

    const ordered = [...doctors].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const total = ordered.length;
    const longitudeRadius = total > 1 ? Math.min(2.2, 0.95 + total * 0.14) : 0;
    const latitudeRadius = total > 1 ? Math.min(1.35, 0.6 + total * 0.08) : 0;

    ordered.forEach((doctor, index) => {
      if (total === 1) {
        entries.push({ doctor, coordinates: center, stackSize: total });
        return;
      }

      const angle = (-Math.PI / 2) + ((Math.PI * 2 * index) / total);
      entries.push({
        doctor,
        coordinates: [
          center[0] + Math.cos(angle) * longitudeRadius,
          center[1] + Math.sin(angle) * latitudeRadius,
        ],
        stackSize: total,
      });
    });
  });

  return entries;
};

export function PhysicianNetworkMap() {
  const [networkDoctors, setNetworkDoctors] = useState<NetworkDoctorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredDoctorId, setHoveredDoctorId] = useState<string | null>(null);
  const [pinnedDoctorId, setPinnedDoctorId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    void settingsAPI
      .getNetworkDoctors()
      .then((response: any) => {
        if (cancelled) {
          return;
        }
        const doctors = Array.isArray(response?.doctors) ? response.doctors : [];
        setNetworkDoctors(doctors);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        console.warn("[PhysicianNetworkMap] Failed to load physician network", loadError);
        setError("Unable to load physician locations right now.");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const normalizedDoctors = useMemo<NormalizedDoctor[]>(
    () =>
      networkDoctors.map((doctor) => {
        const stateCode = normalizeStateCode(doctor.officeState);
        const displayName = normalizeText(doctor.name) || "Physician";
        const bio = normalizeText(doctor.bio);
        return {
          ...doctor,
          bio,
          displayName,
          stateCode,
          locationLabel: buildLocationLabel({
            officeCity: doctor.officeCity,
            greaterArea: doctor.greaterArea,
            stateCode,
          }),
        };
      }),
    [networkDoctors],
  );

  const mappedDoctors = useMemo(
    () => normalizedDoctors.filter((doctor) => doctor.stateCode && doctor.bio),
    [normalizedDoctors],
  );

  const doctorsById = useMemo(() => {
    const next = new Map<string, NormalizedDoctor>();
    mappedDoctors.forEach((doctor) => {
      next.set(doctor.id, doctor);
    });
    return next;
  }, [mappedDoctors]);

  const doctorsByState = useMemo(() => {
    const next = new Map<string, NormalizedDoctor[]>();
    mappedDoctors.forEach((doctor) => {
      const stateCode = doctor.stateCode;
      if (!stateCode) {
        return;
      }
      const bucket = next.get(stateCode) || [];
      bucket.push(doctor);
      next.set(stateCode, bucket);
    });
    return next;
  }, [mappedDoctors]);

  const activeDoctorId = pinnedDoctorId || hoveredDoctorId || mappedDoctors[0]?.id || null;
  const activeDoctor = activeDoctorId ? doctorsById.get(activeDoctorId) || null : null;

  return (
    <div className="w-full max-w-[640px] justify-self-end">
      <div className="rounded-[30px] border border-[rgba(95,179,249,0.18)] bg-white/72 p-3 shadow-[0_30px_80px_-56px_rgba(95,179,249,0.72)] backdrop-blur-xl sm:p-4">
        <div className="mx-auto w-full max-w-[560px]">
          {loading ? (
            <div className="aspect-[1.64] w-full animate-pulse rounded-[26px] bg-[rgba(95,179,249,0.08)]" />
          ) : (
            <ComposableMap
              width={960}
              height={585}
              projection="geoAlbersUsa"
              projectionConfig={{ scale: 1180 }}
              className="h-auto w-full"
              aria-label="United States physician network map"
            >
              <Geographies geography={usStatesTopologyUrl}>
                {({ geographies }) => {
                  const stateCenters = new Map<string, [number, number]>();

                  geographies.forEach((geography: any) => {
                    const stateCode = STATE_CODE_BY_FIPS[String(geography.id).padStart(2, "0")];
                    if (!stateCode) {
                      return;
                    }
                    stateCenters.set(stateCode, geoCentroid(geography) as [number, number]);
                  });

                  const markerEntries = buildMarkerEntries(doctorsByState, stateCenters).sort(
                    (a, b) =>
                      Number(a.doctor.id === activeDoctorId) - Number(b.doctor.id === activeDoctorId),
                  );

                  return (
                    <>
                      {geographies.map((geography: any) => {
                        const stateCode = STATE_CODE_BY_FIPS[String(geography.id).padStart(2, "0")];
                        const hasDoctors = stateCode ? doctorsByState.has(stateCode) : false;
                        const isActive = Boolean(activeDoctor?.stateCode && activeDoctor.stateCode === stateCode);

                        return (
                          <Geography
                            key={geography.rsmKey}
                            geography={geography}
                            style={{
                              default: {
                                fill: hasDoctors
                                  ? isActive
                                    ? "rgba(95, 179, 249, 0.28)"
                                    : "rgba(95, 179, 249, 0.14)"
                                  : "rgba(255,255,255,0.7)",
                                outline: "none",
                                stroke: hasDoctors ? "rgba(95,179,249,0.9)" : "rgba(95,179,249,0.44)",
                                strokeWidth: isActive ? 1.8 : 1.1,
                              },
                              hover: {
                                fill: hasDoctors
                                  ? "rgba(95, 179, 249, 0.28)"
                                  : "rgba(95, 179, 249, 0.08)",
                                outline: "none",
                                stroke: "rgba(95,179,249,0.92)",
                                strokeWidth: 1.5,
                              },
                              pressed: {
                                fill: hasDoctors
                                  ? "rgba(95, 179, 249, 0.32)"
                                  : "rgba(95, 179, 249, 0.10)",
                                outline: "none",
                                stroke: "rgba(95,179,249,0.92)",
                                strokeWidth: 1.5,
                              },
                            }}
                          />
                        );
                      })}

                      {markerEntries.map((entry) => {
                        const isActive = entry.doctor.id === activeDoctorId;

                        return (
                          <Marker key={entry.doctor.id} coordinates={entry.coordinates}>
                            <g
                              tabIndex={0}
                              focusable="true"
                              role="button"
                              aria-label={`${entry.doctor.displayName}${
                                entry.doctor.locationLabel ? `, ${entry.doctor.locationLabel}` : ""
                              }`}
                              style={{ cursor: "pointer", outline: "none" }}
                              onMouseEnter={() => setHoveredDoctorId(entry.doctor.id)}
                              onMouseLeave={() =>
                                setHoveredDoctorId((current) =>
                                  current === entry.doctor.id ? null : current,
                                )
                              }
                              onFocus={() => setHoveredDoctorId(entry.doctor.id)}
                              onBlur={() =>
                                setHoveredDoctorId((current) =>
                                  current === entry.doctor.id ? null : current,
                                )
                              }
                              onClick={() =>
                                setPinnedDoctorId((current) =>
                                  current === entry.doctor.id ? null : entry.doctor.id,
                                )
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setPinnedDoctorId((current) =>
                                    current === entry.doctor.id ? null : entry.doctor.id,
                                  );
                                }
                                if (event.key === "Escape") {
                                  setPinnedDoctorId(null);
                                }
                              }}
                            >
                              <title>{entry.doctor.displayName}</title>
                              {entry.stackSize > 1 ? (
                                <circle
                                  r={isActive ? 16 : 13}
                                  fill="rgba(95,179,249,0.14)"
                                  stroke="rgba(95,179,249,0.22)"
                                  strokeWidth={1}
                                />
                              ) : null}
                              <circle
                                r={isActive ? 8 : 6.5}
                                fill={BRAND_BLUE}
                                fillOpacity={isActive ? 1 : 0.94}
                                stroke="white"
                                strokeWidth={isActive ? 3 : 2.25}
                              />
                            </g>
                          </Marker>
                        );
                      })}
                    </>
                  );
                }}
              </Geographies>
            </ComposableMap>
          )}
        </div>

        <div className="mt-4 rounded-[24px] border border-[rgba(95,179,249,0.18)] bg-white/84 p-4 backdrop-blur-md">
          {error ? (
            <p className="text-sm font-medium text-[rgb(26,85,173)]">{error}</p>
          ) : mappedDoctors.length === 0 ? (
            <p className="text-sm font-medium text-[rgb(26,85,173)]">
              Physician profiles are visible, but no map locations are available yet.
            </p>
          ) : activeDoctor ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold leading-tight text-[rgb(26,85,173)]">
                    {activeDoctor.displayName}
                  </h3>
                  {activeDoctor.locationLabel ? (
                    <p className="mt-1 text-sm font-medium text-[rgba(26,85,173,0.78)]">
                      {activeDoctor.locationLabel}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {activeDoctor.studyFocus ? (
                    <span className="rounded-full border border-[rgba(95,179,249,0.22)] bg-[rgba(95,179,249,0.08)] px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-[rgb(95,179,249)]">
                      {activeDoctor.studyFocus}
                    </span>
                  ) : null}
                  {pinnedDoctorId ? (
                    <button
                      type="button"
                      className="rounded-full border border-[rgba(95,179,249,0.16)] bg-white/80 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-[rgba(26,85,173,0.78)] transition-colors hover:border-[rgba(95,179,249,0.3)] hover:text-[rgb(95,179,249)]"
                      onClick={() => setPinnedDoctorId(null)}
                    >
                      Clear selection
                    </button>
                  ) : null}
                </div>
              </div>

              <p className="max-h-28 overflow-y-auto pr-1 text-sm leading-6 text-[rgba(26,85,173,0.88)]">
                {activeDoctor.bio}
              </p>
            </div>
          ) : (
            <p className="text-sm font-medium text-[rgb(26,85,173)]">
              Hover or tap a physician marker to view profile details.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
