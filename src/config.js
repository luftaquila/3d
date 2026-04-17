const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
};

const optional = (name, fallback) => process.env[name] ?? fallback;

export const config = {
  port: Number(optional('PORT', '3000')),
  dataDir: optional('DATA_DIR', '/data'),
  publicOrigin: required('PUBLIC_ORIGIN'),
  sessionSecret: required('SESSION_SECRET'),
  adminEmail: required('ADMIN_EMAIL').toLowerCase(),
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    redirectUrl: required('GOOGLE_REDIRECT_URL'),
  },
  brevo: {
    apiKey: optional('BREVO_API_KEY', ''),
    fromEmail: optional('BREVO_FROM_EMAIL', ''),
    fromName: optional('BREVO_FROM_NAME', '3D Print Service'),
  },
  homeassistant: {
    url: optional('HA_URL', ''),
    token: optional('HA_TOKEN', ''),
    cameraEntity: optional('HA_CAMERA_ENTITY', ''),
  },
  naverPlace: {
    lat: optional('NAVER_PLACE_LAT', ''),
    lng: optional('NAVER_PLACE_LNG', ''),
    name: optional('NAVER_PLACE_NAME', ''),
    address: optional('NAVER_PLACE_ADDRESS', ''),
    url: optional('NAVER_PLACE_URL', ''),
    mapsClientId: optional('NAVER_MAPS_CLIENT_ID', ''),
  },
  limits: {
    fileSizeBytes: 100 * 1024 * 1024,
    totalSizeBytes: 500 * 1024 * 1024,
    maxFilesPerQuote: 20,
    userQuotaBytes: 1024 * 1024 * 1024,
    maxTriangles: 5_000_000,
  },
  isProd: process.env.NODE_ENV === 'production',
};
