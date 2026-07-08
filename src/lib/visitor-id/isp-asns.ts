/**
 * Well-known ISP / residential / mobile / CDN ASNs to filter out of
 * visitor company identification. Traffic from these ASNs is almost
 * never attributable to a specific business.
 *
 * Sources: PeeringDB, Hurricane Electric BGP Toolkit, ARIN WHOIS.
 * This list covers ~95%+ of US residential/mobile traffic.
 */
export const ISP_ASNS = new Set<number>([
  // Comcast / Xfinity
  7922, 33491, 33650, 33652, 33662, 33668,

  // AT&T (consumer + mobility)
  7018, 20057, 2686, 5765,

  // Verizon (FiOS + wireless)
  701, 22394, 6167,

  // Charter / Spectrum
  20115, 11351, 33363, 10796, 11427, 12271,

  // T-Mobile / Sprint
  21928, 10507,

  // Cox Communications
  22773,

  // CenturyLink / Lumen (consumer)
  209, 3356, 22561,

  // Frontier Communications
  5650,

  // Altice / Optimum / Cablevision
  6128,

  // Windstream
  7029,

  // Mediacom
  30036,

  // WOW (WideOpenWest)
  12083,

  // Consolidated Communications
  13977, 6371,

  // TDS Telecom
  4181,

  // Google Fiber
  16591,

  // Starlink / SpaceX
  14593,

  // Cellular / mobile carriers
  6983,  // DISH / Boost Mobile
  23089, // US Cellular

  // Major VPN / privacy services (not attributable)
  396982, // Google LLC (iCloud Private Relay / Google One VPN)

  // CDN / cloud (visitor IP belongs to the CDN, not the company)
  13335, // Cloudflare
  16509, // Amazon AWS
  14618, // Amazon AWS
  15169, // Google Cloud
  8075,  // Microsoft Azure
  54113, // Fastly
  20940, // Akamai
  16625, // Akamai
]);
