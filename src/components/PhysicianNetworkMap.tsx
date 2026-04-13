import { useEffect, useMemo, useState } from "react";
import { geoAlbersUsa, geoCentroid } from "d3-geo";
import { feature } from "topojson-client";
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
} from "react-simple-maps";
import usStatesTopologyUrl from "us-atlas/states-10m.json?url";
import { resolveApproximateUsPlaceCoordinates, type MapLocationPrecision } from "../lib/physicianMapLocations";
import { settingsAPI } from "../services/api";

type NetworkDoctorRecord = {
  id: string;
  name?: string | null;
  email?: string | null;
  profileImageUrl?: string | null;
  greaterArea?: string | null;
  studyFocus?: string | null;
  bio?: string | null;
  officeCity?: string | null;
  officeState?: string | null;
  lastLoginAt?: string | null;
};

type NormalizedDoctor = NetworkDoctorRecord & {
  displayName: string;
  stateCode: string | null;
  locationLabel: string | null;
  coordinates: [number, number] | null;
  locationPrecision: MapLocationPrecision;
  lastLoginMs: number | null;
};

type ClusterEntry = {
  id: string;
  coordinates: [number, number];
  doctors: NormalizedDoctor[];
  locationLabel: string | null;
  kind: "precise" | "state";
};

const BRAND_BLUE = "rgb(95, 179, 249)";
const MAP_WIDTH = 960;
const MAP_HEIGHT = 585;
const CLUSTER_RADIUS_PX = 30;

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

const parseIsoTimestamp = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const compareDoctorsByRecentLogin = (a: NormalizedDoctor, b: NormalizedDoctor) => {
  const aLastLoginMs = a.lastLoginMs;
  const bLastLoginMs = b.lastLoginMs;
  if (aLastLoginMs !== bLastLoginMs) {
    if (aLastLoginMs === null) {
      return 1;
    }
    if (bLastLoginMs === null) {
      return -1;
    }
    return bLastLoginMs - aLastLoginMs;
  }
  const nameCompare = a.displayName.localeCompare(b.displayName);
  if (nameCompare !== 0) {
    return nameCompare;
  }
  return a.id.localeCompare(b.id);
};

const buildLocationLabel = (doctor: {
  officeCity?: string | null;
  greaterArea?: string | null;
  stateCode?: string | null;
}) => {
  const city = normalizeText(doctor.officeCity);
  const area = normalizeText(doctor.greaterArea);
  const stateCode = normalizeText(doctor.stateCode);

  if (area && stateCode) {
    return `${area}, ${stateCode}`;
  }
  if (area) {
    return area;
  }
  if (city && stateCode) {
    return `${city}, ${stateCode}`;
  }
  if (city) {
    return city;
  }
  if (stateCode) {
    return STATE_NAME_BY_CODE[stateCode] || stateCode;
  }
  return null;
};

const buildClusterLocationLabel = (doctors: NormalizedDoctor[]) => {
  const counts = new Map<string, number>();

  doctors.forEach((doctor) => {
    const label = doctor.locationLabel || (doctor.stateCode ? STATE_NAME_BY_CODE[doctor.stateCode] : null);
    if (!label) {
      return;
    }
    counts.set(label, (counts.get(label) || 0) + 1);
  });

  const bestLabel = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return bestLabel || doctors[0]?.locationLabel || null;
};

const buildClusterEntries = (
  doctors: NormalizedDoctor[],
  projection: ReturnType<typeof geoAlbersUsa>,
): ClusterEntry[] => {
  type MutableCluster = {
    coordinates: [number, number];
    projected: [number, number];
    doctors: NormalizedDoctor[];
    kind: "precise" | "state";
    stateCode: string | null;
  };

  const sortedDoctors = [...doctors].sort(compareDoctorsByRecentLogin);

  const clusters: MutableCluster[] = [];

  sortedDoctors.forEach((doctor) => {
    if (!doctor.coordinates) {
      return;
    }

    const projected = projection(doctor.coordinates);
    if (!projected) {
      return;
    }

    const doctorKind = doctor.locationPrecision === "state" ? "state" : "precise";
    let bestCluster: MutableCluster | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    clusters.forEach((cluster) => {
      if (cluster.kind !== doctorKind) {
        return;
      }
      if (cluster.kind === "state" && cluster.stateCode !== doctor.stateCode) {
        return;
      }

      const threshold = cluster.kind === "state" ? 22 : CLUSTER_RADIUS_PX;
      const distance = Math.hypot(projected[0] - cluster.projected[0], projected[1] - cluster.projected[1]);

      if (distance <= threshold && distance < bestDistance) {
        bestCluster = cluster;
        bestDistance = distance;
      }
    });

    if (!bestCluster) {
      clusters.push({
        coordinates: doctor.coordinates,
        projected: [projected[0], projected[1]],
        doctors: [doctor],
        kind: doctorKind,
        stateCode: doctor.stateCode,
      });
      return;
    }

    const nextCount = bestCluster.doctors.length + 1;
    bestCluster.coordinates = [
      ((bestCluster.coordinates[0] * bestCluster.doctors.length) + doctor.coordinates[0]) / nextCount,
      ((bestCluster.coordinates[1] * bestCluster.doctors.length) + doctor.coordinates[1]) / nextCount,
    ];
    bestCluster.projected = [
      ((bestCluster.projected[0] * bestCluster.doctors.length) + projected[0]) / nextCount,
      ((bestCluster.projected[1] * bestCluster.doctors.length) + projected[1]) / nextCount,
    ];
    bestCluster.doctors.push(doctor);
  });

  return clusters.map((cluster) => {
    const doctorsInCluster = [...cluster.doctors].sort(compareDoctorsByRecentLogin);
    return {
      id: doctorsInCluster.map((doctor) => doctor.id).sort().join("__"),
      coordinates: cluster.coordinates,
      doctors: doctorsInCluster,
      locationLabel: buildClusterLocationLabel(doctorsInCluster),
      kind: cluster.kind,
    };
  });
};

export function PhysicianNetworkMap() {
  const [networkDoctors, setNetworkDoctors] = useState<NetworkDoctorRecord[]>([]);
  const [stateCenters, setStateCenters] = useState<Map<string, [number, number]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredClusterId, setHoveredClusterId] = useState<string | null>(null);
  const [pinnedClusterId, setPinnedClusterId] = useState<string | null>(null);
  const [selectedDoctorId, setSelectedDoctorId] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;

    void fetch(usStatesTopologyUrl)
      .then((response) => response.json())
      .then((topology) => {
        if (cancelled) {
          return;
        }

        const stateObject = (topology as any)?.objects?.states;
        if (!stateObject) {
          return;
        }

        const collection = feature(topology as any, stateObject) as any;
        const nextCenters = new Map<string, [number, number]>();

        (collection?.features || []).forEach((geography: any) => {
          const stateCode = STATE_CODE_BY_FIPS[String(geography.id).padStart(2, "0")];
          if (!stateCode) {
            return;
          }
          nextCenters.set(stateCode, geoCentroid(geography) as [number, number]);
        });

        setStateCenters(nextCenters);
      })
      .catch((loadError) => {
        console.warn("[PhysicianNetworkMap] Failed to resolve state centroids", loadError);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const projection = useMemo(
    () => geoAlbersUsa().scale(1180).translate([MAP_WIDTH / 2, MAP_HEIGHT / 2]),
    [],
  );

  const normalizedDoctors = useMemo<NormalizedDoctor[]>(
    () => {
      const nextDoctors = networkDoctors.map((doctor) => {
        const stateCode = normalizeStateCode(doctor.officeState);
        const displayName = normalizeText(doctor.name) || "Physician";
        const email = normalizeText(doctor.email);
        const bio = normalizeText(doctor.bio);
        const lastLoginAt = normalizeText(doctor.lastLoginAt);
        const resolvedLocation = resolveApproximateUsPlaceCoordinates({
          greaterArea: doctor.greaterArea,
          officeCity: doctor.officeCity,
          stateCode,
          fallbackCoordinates: stateCode ? stateCenters.get(stateCode) || null : null,
        });

        return {
          ...doctor,
          bio,
          displayName,
          email,
          lastLoginAt,
          lastLoginMs: parseIsoTimestamp(lastLoginAt),
          stateCode,
          locationLabel: buildLocationLabel({
            officeCity: doctor.officeCity,
            greaterArea: doctor.greaterArea,
            stateCode,
          }),
          coordinates: resolvedLocation.coordinates,
          locationPrecision: resolvedLocation.precision,
        };
      });
      nextDoctors.sort(compareDoctorsByRecentLogin);
      return nextDoctors;
    },
    [networkDoctors, stateCenters],
  );

  const mappedDoctors = useMemo(
    () => normalizedDoctors.filter((doctor) => Boolean(doctor.coordinates)),
    [normalizedDoctors],
  );

  const doctorsByState = useMemo(() => {
    const next = new Map<string, NormalizedDoctor[]>();
    mappedDoctors.forEach((doctor) => {
      if (!doctor.stateCode) {
        return;
      }
      const bucket = next.get(doctor.stateCode) || [];
      bucket.push(doctor);
      next.set(doctor.stateCode, bucket);
    });
    return next;
  }, [mappedDoctors]);

  const clusterEntries = useMemo(
    () => buildClusterEntries(mappedDoctors, projection),
    [mappedDoctors, projection],
  );

  const clustersById = useMemo(() => {
    const next = new Map<string, ClusterEntry>();
    clusterEntries.forEach((cluster) => {
      next.set(cluster.id, cluster);
    });
    return next;
  }, [clusterEntries]);

  useEffect(() => {
    if (hoveredClusterId && !clustersById.has(hoveredClusterId)) {
      setHoveredClusterId(null);
    }
    if (pinnedClusterId && !clustersById.has(pinnedClusterId)) {
      setPinnedClusterId(null);
    }
    if (selectedDoctorId && !mappedDoctors.some((doctor) => doctor.id === selectedDoctorId)) {
      setSelectedDoctorId(null);
    }
  }, [clustersById, hoveredClusterId, pinnedClusterId, selectedDoctorId, mappedDoctors]);

  const activeClusterId = hoveredClusterId || pinnedClusterId || clusterEntries[0]?.id || null;
  const activeCluster = activeClusterId ? clustersById.get(activeClusterId) || null : null;
  const activeDoctor = useMemo(() => {
    if (!activeCluster) {
      return null;
    }
    return (
      activeCluster.doctors.find((doctor) => doctor.id === selectedDoctorId)
      || activeCluster.doctors[0]
      || null
    );
  }, [activeCluster, selectedDoctorId]);

  const activeStateCodes = useMemo(() => {
    const next = new Set<string>();
    (activeCluster?.doctors || []).forEach((doctor) => {
      if (doctor.stateCode) {
        next.add(doctor.stateCode);
      }
    });
    return next;
  }, [activeCluster]);

  const sortedClusterEntries = useMemo(
    () =>
      [...clusterEntries].sort(
        (a, b) =>
          Number(a.id === activeClusterId) - Number(b.id === activeClusterId)
          || a.doctors.length - b.doctors.length,
      ),
    [clusterEntries, activeClusterId],
  );

  return (
    <div className="physician-network-map-shell w-full md:self-start">
      <div className="physician-network-map-card p-3 sm:p-4">
        <div className="mx-auto w-full max-w-[560px] md:max-w-full">
          {loading ? (
            <div className="physician-network-map-loading aspect-[1.64] w-full animate-pulse" />
          ) : (
            <div className="physician-network-map-frame overflow-hidden">
              <ComposableMap
                width={MAP_WIDTH}
                height={MAP_HEIGHT}
                projection="geoAlbersUsa"
                projectionConfig={{ scale: 1180 }}
                className="h-auto w-full"
                aria-label="United States physician network map"
              >
                <Geographies geography={usStatesTopologyUrl}>
                  {({ geographies }) => (
                    <>
                      {geographies.map((geography: any) => {
                        const stateCode = STATE_CODE_BY_FIPS[String(geography.id).padStart(2, "0")];
                        const hasDoctors = stateCode ? doctorsByState.has(stateCode) : false;
                        const isActive = stateCode ? activeStateCodes.has(stateCode) : false;

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

                      {sortedClusterEntries.map((cluster) => {
                        const isActive = cluster.id === activeClusterId;
                        const clusterCount = cluster.doctors.length;
                        const countLabel = clusterCount > 99 ? "99+" : String(clusterCount);
                        const representative = cluster.doctors[0];
                        const markerLabel = clusterCount > 1
                          ? `${clusterCount} physicians${cluster.locationLabel ? ` near ${cluster.locationLabel}` : ""}`
                          : `${representative.displayName}${representative.locationLabel ? `, ${representative.locationLabel}` : ""}`;

                        return (
                          <Marker key={cluster.id} coordinates={cluster.coordinates}>
                            <g
                              tabIndex={0}
                              focusable="true"
                              role="button"
                              aria-label={markerLabel}
                              style={{ cursor: "pointer", outline: "none" }}
                              onMouseEnter={() => setHoveredClusterId(cluster.id)}
                              onMouseLeave={() =>
                                setHoveredClusterId((current) =>
                                  current === cluster.id ? null : current,
                                )
                              }
                              onFocus={() => setHoveredClusterId(cluster.id)}
                              onBlur={() =>
                                setHoveredClusterId((current) =>
                                  current === cluster.id ? null : current,
                                )
                              }
                              onClick={() => {
                                setSelectedDoctorId(representative.id);
                                setPinnedClusterId((current) => (current === cluster.id ? null : cluster.id));
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setSelectedDoctorId(representative.id);
                                  setPinnedClusterId((current) => (current === cluster.id ? null : cluster.id));
                                }
                                if (event.key === "Escape") {
                                  setPinnedClusterId(null);
                                }
                              }}
                            >
                              <title>{markerLabel}</title>
                              {clusterCount > 1 ? (
                                <>
                                  <circle
                                    r={isActive ? 17.5 : 15}
                                    fill="rgba(95,179,249,0.18)"
                                    stroke="white"
                                    strokeWidth={isActive ? 3 : 2}
                                  />
                                  <circle
                                    r={isActive ? 13 : 11}
                                    fill={BRAND_BLUE}
                                    fillOpacity={isActive ? 1 : 0.96}
                                    stroke="rgba(26,85,173,0.18)"
                                    strokeWidth={1}
                                  />
                                  <text
                                    y={4.25}
                                    textAnchor="middle"
                                    className="select-none fill-white text-[10px] font-bold"
                                  >
                                    {countLabel}
                                  </text>
                                </>
                              ) : (
                                <>
                                  {cluster.kind === "state" ? (
                                    <circle
                                      r={isActive ? 14 : 11.5}
                                      fill="rgba(95,179,249,0.12)"
                                      stroke="rgba(95,179,249,0.18)"
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
                                </>
                              )}
                            </g>
                          </Marker>
                        );
                      })}
                    </>
                  )}
                </Geographies>
              </ComposableMap>
            </div>
          )}
        </div>

        {error || mappedDoctors.length > 0 ? (
          <div className="physician-network-map-details mt-4 p-4">
            {error ? (
              <p className="physician-network-map-copy text-sm font-medium">{error}</p>
            ) : activeCluster && activeDoctor ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="physician-network-map-title text-xl font-semibold leading-tight">
                      {activeCluster.locationLabel || activeDoctor.locationLabel || activeDoctor.displayName}
                    </h3>
                    <p className="physician-network-map-subtitle mt-1 text-sm font-medium">
                      {activeCluster.doctors.length > 1
                        ? `${activeCluster.doctors.length} physicians shown in this area`
                        : "Physician network presence"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {pinnedClusterId ? (
                      <button
                        type="button"
                        className="physician-network-map-clear-button header-home-button bg-white px-4 text-slate-900 shrink-0"
                        onClick={() => setPinnedClusterId(null)}
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                </div>

                {activeCluster.doctors.length > 1 ? (
                  <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto pr-1">
                    {activeCluster.doctors.map((doctor) => {
                      const isSelected = doctor.id === activeDoctor.id;
                      return (
                        <button
                          key={doctor.id}
                          type="button"
                          className={`physician-network-map-doctor-chip px-3 py-1 text-xs font-semibold transition-colors ${
                            isSelected
                              ? "physician-network-map-doctor-chip--active"
                              : ""
                          }`}
                          onClick={() => {
                            setPinnedClusterId(activeCluster.id);
                            setSelectedDoctorId(doctor.id);
                          }}
                        >
                          {doctor.displayName}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="physician-network-map-profile-card space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 className="physician-network-map-profile-name text-lg font-semibold leading-tight">
                        {activeDoctor.displayName}
                      </h4>
                      {activeDoctor.email ? (
                        <a
                          href={`mailto:${activeDoctor.email}`}
                          className="physician-network-map-email mt-1 block w-fit break-all text-sm font-medium transition-colors"
                        >
                          {activeDoctor.email}
                        </a>
                      ) : null}
                      {activeDoctor.locationLabel ? (
                        <p className="physician-network-map-location mt-1 text-sm font-medium">
                          {activeDoctor.locationLabel}
                        </p>
                      ) : null}
                    </div>
                    {activeDoctor.studyFocus ? (
                      <span className="physician-network-map-focus-badge px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em]">
                        {activeDoctor.studyFocus}
                      </span>
                    ) : null}
                  </div>

                  {activeDoctor.bio ? (
                    <p className="physician-network-map-bio max-h-28 overflow-y-auto pr-1 text-sm leading-6">
                      {activeDoctor.bio}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="physician-network-map-copy text-sm font-medium">
                Hover or tap a physician marker to view profile details.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
