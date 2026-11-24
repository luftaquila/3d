"""Upload a sliced project to the Bambu Lab printer's SD card over implicit
FTPS (port 990, user bblp, the printer's LAN access code).

Same approach as the Home Assistant Bambu Lab integration (pybambu): the data
connection must reuse the control connection's TLS session, and the printer
never answers a TLS close on the data socket, so it is closed without unwrap.
printer-ca.pem is the Bambu Lab device CA bundle shipped with that integration.
"""

import ftplib
import os
import ssl
import unicodedata

HOST = os.environ.get("PRINTER_HOST", "")
ACCESS_CODE = os.environ.get("PRINTER_ACCESS_CODE", "")
CA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "printer-ca.pem")
PORT = 990


def configured():
    return bool(HOST and ACCESS_CODE)


def _context():
    ctx = ssl.create_default_context(cafile=CA_FILE)
    # the device CA has no key-usage extension (rejected by strict mode), and
    # the certificate names the printer's serial, not its IP
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    ctx.check_hostname = False
    ctx.maximum_version = ssl.TLSVersion.TLSv1_2
    return ctx


class _ImplicitFTPS(ftplib.FTP_TLS):
    """FTP_TLS that is TLS from the first byte (implicit FTPS)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._sock = None

    @property
    def sock(self):
        return self._sock

    @sock.setter
    def sock(self, value):
        if value is not None and not isinstance(value, ssl.SSLSocket):
            value = self.context.wrap_socket(value)
        self._sock = value

    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)
        return conn, size


def _remote_size(ftp, name):
    """Size of name in the SD card root from LIST (SIZE fails on some names),
    or None if it isn't there."""
    lines = []
    ftp.retrlines("LIST", lines.append)
    for line in lines:
        parts = line.split(None, 8)
        if len(parts) == 9 and unicodedata.normalize("NFC", parts[8]) == name:
            try:
                return int(parts[4])
            except ValueError:
                return None
    return None


def upload(local_path, remote_name, on_progress=None, timeout=60):
    """Store local_path as remote_name in the SD card root.

    remote_name must be NFC: the printer lists an NFD (macOS-style decomposed
    Hangul) name but cannot open it, and reports that as an SD card error when
    asked to print it. A file already there with the same size is reused
    (re-sending one took ~10 minutes at the printer's ~130KB/s).
    on_progress(sent, total) is called while sending.
    Returns (size on the printer, reused).
    """
    if unicodedata.normalize("NFC", remote_name) != remote_name:
        raise ValueError("remote name must be NFC")
    total = os.path.getsize(local_path)
    ftp = _ImplicitFTPS(context=_context())
    ftp.connect(HOST, PORT, timeout=timeout)
    try:
        ftp.login("bblp", ACCESS_CODE)
        ftp.prot_p()
        ftp.voidcmd("TYPE I")
        if _remote_size(ftp, remote_name) == total:
            if on_progress:
                on_progress(total, total)
            return total, True
        sent = 0
        with open(local_path, "rb") as fh:
            conn = ftp.transfercmd(f"STOR {remote_name}")
            try:
                while True:
                    chunk = fh.read(64 * 1024)
                    if not chunk:
                        break
                    conn.sendall(chunk)
                    sent += len(chunk)
                    if on_progress:
                        on_progress(sent, total)
            finally:
                conn.close()  # no unwrap(): the printer never answers it
        ftp.voidresp()
        return _remote_size(ftp, remote_name), False
    finally:
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()
