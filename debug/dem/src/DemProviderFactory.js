import mapray from "@mapray/mapray-js";

const DEFAULT_PROVIDER = "cloud";

export function createDebugDemProvider(value) {
  const name = normalizeProviderName(value);

  switch (name) {
    case "terrain-rgb":
      return createRasterDebugDemProvider(name, "terrain-rgb", {
        url: "https://gbank.gsj.jp/seamless/elev/terrainRGB/mixed/{z}/{y}/{x}.png",
        encoding: {
          type: "terrain-rgb",
          invalid_height: 0,
          invalid_fill: "ancestor",
        },
        max_zoom: 17,
      });

    case "signed-rgb":
      return createRasterDebugDemProvider(name, "signed-rgb", {
        url: "https://tiles.gsj.jp/tiles/elev/mixed/{z}/{y}/{x}.png",
        encoding: {
          type: "signed-rgb",
          invalid_height: 0,
          invalid_fill: "ancestor",
        },
        max_zoom: 15,
      });

    case "flat":
      return {
        name,
        label: "flat",
        dem_provider: new mapray.FlatDemProvider({
          max_level: 17,
          rho: 8,
          height: 0,
        }),
      };

    case "cloud":
      return {
        name,
        label: "mapray cloud",
      };
  }
}

function createRasterDebugDemProvider(name, label, options) {
  return {
    name,
    label,
    dem_provider: new mapray.RasterDemProvider({
      source: {
        type: "zxy",
        url: options.url,
      },
      encoding: options.encoding,
      max_zoom: options.max_zoom,
      missing_tile_height: 0,
      request_limit: 32,
    }),
  };
}

function normalizeProviderName(value) {
  switch (value) {
    case undefined:
    case null:
    case "":
    case "cloud":
    case "mapray-cloud":
      return "cloud";

    case "terrain-rgb":
    case "terrainRGB":
      return "terrain-rgb";

    case "signed-rgb":
      return "signed-rgb";

    case "flat":
      return "flat";

    default:
      console.warn(
        `Unknown DEM provider: ${value}. Fallback to ${DEFAULT_PROVIDER}.`,
      );
      return DEFAULT_PROVIDER;
  }
}
