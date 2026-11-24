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


def upload(local_path, remote_name, timeout=60):
    """Store local_path as remote_name in the SD card root; returns the size on the printer."""
    ftp = _ImplicitFTPS(context=_context())
    ftp.connect(HOST, PORT, timeout=timeout)
    try:
        ftp.login("bblp", ACCESS_CODE)
        ftp.prot_p()
        ftp.voidcmd("TYPE I")
        with open(local_path, "rb") as fh:
            conn = ftp.transfercmd(f"STOR {remote_name}")
            try:
                while True:
                    chunk = fh.read(64 * 1024)
                    if not chunk:
                        break
                    conn.sendall(chunk)
            finally:
                conn.close()  # no unwrap(): the printer never answers it
        ftp.voidresp()
        try:
            return ftp.size(remote_name)
        except ftplib.all_errors:
            return None
    finally:
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()
