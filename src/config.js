import crypto from 'node:crypto';

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
};

const optional = (name, fallback) => process.env[name] ?? fallback;

const sessionSecret = required('SESSION_SECRET');

export const config = {
  port: Number(optional('PORT', '3000')),
  dataDir: optional('DATA_DIR', '/data'),
  publicOrigin: required('PUBLIC_ORIGIN'),
  sessionSecret,
  cameraStreamKey: crypto.createHash('sha256').update(`${sessionSecret}:camera-stream`).digest(),
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
  sens: {
    // Naver Cloud Platform SENS v2 (SMS). All optional — when any is missing
    // the SMS feature stays disabled and send attempts are rejected.
    accessKey: optional('SENS_ACCESS_KEY', ''),
    secretKey: optional('SENS_SECRET_KEY', ''),
    serviceId: optional('SENS_SERVICE_ID', ''),
    fromNumber: optional('SENS_FROM_NUMBER', ''),
  },
  homeassistant: {
    url: optional('HA_URL', ''),
    token: optional('HA_TOKEN', ''),
    cameraEntity: optional('HA_CAMERA_ENTITY', ''),
    // Bambu device slug for the print-status sensors (sensor.<prefix>_current_layer
    // etc.). Optional — defaults to deriving from cameraEntity (camera.<prefix>_camera).
    printerPrefix: optional('HA_PRINTER_PREFIX', ''),
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
    fileSizeBytes: 200 * 1024 * 1024,
    totalSizeBytes: 500 * 1024 * 1024,
    maxFilesPerQuote: 20,
    userQuotaBytes: 1024 * 1024 * 1024,
    maxTriangles: 5_000_000,
  },
  isProd: process.env.NODE_ENV === 'production',
};
