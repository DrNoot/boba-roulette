/**
 * Boba Roulette - Data Layer
 * All boba shop locations, starting points, venues, and route utilities.
 * Exposed on window.BobaData.
 */

window.BobaData = {
  // Starting locations
  starts: {
    daniels: { name: "Daniel's Place", lat: 43.793, lng: -79.470 },
    friends: { name: "Friend's Place", lat: 43.800, lng: -79.455 },
  },

  // Volleyball venues
  venues: {
    aaniin:  { name: "Aaniin Community Centre",  address: "5665 14th Ave, Markham",        lat: 43.8396, lng: -79.2629 },
    vellore: { name: "Vellore Village CC",        address: "1 Villa Royale Ave, Vaughan",   lat: 43.8286, lng: -79.5311 },
  },

  // Boba places - verified real locations in North York / Vaughan / Markham, Ontario
  places: [
    { id: "choo-tea",         name: "Choo Tea",                  address: "5 Northtown Way #4, North York",          lat: 43.7614, lng: -79.4097, area: "North York" },
    { id: "machi-machi",      name: "Machi Machi",               address: "5317 Yonge St, North York",               lat: 43.7770, lng: -79.4155, area: "North York" },
    { id: "the-alley",        name: "The Alley",                 address: "5431 Yonge St, North York",               lat: 43.7783, lng: -79.4156, area: "North York" },
    { id: "tiger-sugar",      name: "Tiger Sugar",               address: "5418 Yonge St, North York",               lat: 43.7780, lng: -79.4156, area: "North York" },
    { id: "gong-cha",         name: "Gong Cha",                  address: "5449 Yonge St, North York",               lat: 43.7784, lng: -79.4154, area: "North York" },
    { id: "kung-fu-tea",      name: "Kung Fu Tea",               address: "4893 Yonge St, North York",               lat: 43.7626, lng: -79.4103, area: "North York" },
    { id: "coco",             name: "CoCo Fresh Tea",            address: "17B Finch Ave W, North York",             lat: 43.7800, lng: -79.4180, area: "North York" },
    { id: "presotea-markham", name: "Presotea",                  address: "3255 Hwy 7 E, Markham",                   lat: 43.8469, lng: -79.3375, area: "Markham"   },
    { id: "heytea",           name: "HEYTEA",                    address: "5000 Hwy 7, Markville Mall, Markham",     lat: 43.8693, lng: -79.2667, area: "Markham"   },
    { id: "tiger-sugar-mk",   name: "Tiger Sugar (Markham)",     address: "32 S Unionville Ave, Markham",            lat: 43.8625, lng: -79.3147, area: "Markham"   },
    { id: "the-alley-mk",     name: "The Alley (Unionville)",    address: "142 Main St Unionville, Markham",         lat: 43.8628, lng: -79.3191, area: "Markham"   },
    { id: "coco-markham",     name: "CoCo (Markham)",            address: "8360 Kennedy Rd #B15, Markham",           lat: 43.8267, lng: -79.2888, area: "Markham"   },
    { id: "chatime",          name: "Chatime",                   address: "Various GTA locations",                   lat: 43.790,  lng: -79.410,  area: "Multiple"  },
    { id: "presotea-ny",      name: "Presotea (Don Mills)",      address: "3555 Don Mills Rd, North York",           lat: 43.770,  lng: -79.345,  area: "North York" },
    { id: "real-fruit",       name: "Real Fruit Bubble Tea",     address: "Yonge Sheppard Centre, North York",       lat: 43.762,  lng: -79.411,  area: "North York" },
    { id: "tp-tea",           name: "TP Tea",                    address: "3175 Rutherford Rd, Vaughan Mills",       lat: 43.826,  lng: -79.537,  area: "Vaughan"   },
  ],

  // Chip colors cycling palette (matches CSS --chip-N vars)
  chipColors: [
    '#f97316', '#ec4899', '#a855f7', '#14b8a6', '#f59e0b',
    '#ef4444', '#8b5cf6', '#06b6d4', '#10b981', '#f43f5e',
  ],

  // Wheel segment colors
  wheelColors: [
    '#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#6a4c93',
    '#1982c4', '#ff6b6b', '#06d6a0', '#bc8cff', '#f0883e',
  ],

  /**
   * Haversine formula: straight-line distance between two lat/lng points in km.
   * @param {number} lat1
   * @param {number} lng1
   * @param {number} lat2
   * @param {number} lng2
   * @returns {number} Distance in kilometres
   */
  _haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth radius in km
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  /**
   * Estimate extra detour time (in minutes) to stop at a boba place on the
   * way from a starting location to a volleyball venue.
   *
   * Methodology:
   *   - Straight-line distances scaled by road factor 1.4 to approximate driving distance.
   *   - Average GTA driving speed assumed to be 40 km/h.
   *   - A fixed 5-minute stop time is added for ordering / waiting.
   *
   * @param {string} startKey  - Key in BobaData.starts (e.g. "daniels")
   * @param {string} venueKey  - Key in BobaData.venues (e.g. "aaniin")
   * @param {Object} place     - A place object from BobaData.places
   * @returns {number} Rounded extra detour time in minutes
   */
  calcDetour(startKey, venueKey, place) {
    const ROAD_FACTOR = 1.4;
    const SPEED_KMH   = 40;
    const STOP_MIN    = 5;

    const start = this.starts[startKey];
    const venue = this.venues[venueKey];

    if (!start || !venue || !place) return Infinity;

    // Straight-line distances (km)
    const directKm  = this._haversineKm(start.lat, start.lng, venue.lat, venue.lng);
    const toBobaKm  = this._haversineKm(start.lat, start.lng, place.lat, place.lng);
    const toVenueKm = this._haversineKm(place.lat, place.lng, venue.lat, venue.lng);

    // Apply road factor to convert straight-line to estimated driving distance
    const directDriveKm  = directKm  * ROAD_FACTOR;
    const detourDriveKm  = (toBobaKm + toVenueKm) * ROAD_FACTOR;

    // Extra driving time (hours) converted to minutes, plus stop time
    const extraMin = ((detourDriveKm - directDriveKm) / SPEED_KMH) * 60 + STOP_MIN;

    return Math.round(extraMin);
  },

  /**
   * Return places filtered by a maximum detour time, sorted by detour ascending.
   *
   * @param {string} startKey     - Key in BobaData.starts
   * @param {string} venueKey     - Key in BobaData.venues
   * @param {number} maxDetourMin - Maximum acceptable detour in minutes
   * @returns {Array} Filtered and sorted array of place objects, each augmented
   *                  with a `detourMin` property.
   */
  getFilteredPlaces(startKey, venueKey, maxDetourMin) {
    return this.places
      .map((place) => ({
        ...place,
        detourMin: this.calcDetour(startKey, venueKey, place),
      }))
      .filter((place) => place.detourMin <= maxDetourMin)
      .sort((a, b) => a.detourMin - b.detourMin);
  },
};
