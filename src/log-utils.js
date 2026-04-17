export function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
}

export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  const tail = digits.slice(-4);
  return `***-****-${tail}`;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
export function isUlid(s) {
  return typeof s === 'string' && ULID_RE.test(s);
}
