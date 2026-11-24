# Slicer worker for 3d.luftaquila.io: Bambu Studio CLI + orientation pipeline.
FROM docker.io/library/ubuntu:24.04

ARG BAMBU_VERSION=v02.08.02.61
ARG BAMBU_APPIMAGE=BambuStudio_ubuntu24.04-v02.08.02.61-20260820225108.AppImage
ARG BAMBU_SHA256=d501b103fac5424513ec0e8d6bc145fb30719de2c7d94d7320d723740c81a7fd

ENV DEBIAN_FRONTEND=noninteractive
# Runtime libraries the bambu-studio binary links against (GTK/WebKit/GStreamer
# are linked even though the CLI never opens a window).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libgl1 libegl1 libglu1-mesa \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libfontconfig1 libdbus-1-3 \
      libwayland-client0 libwayland-server0 \
      python3 python3-venv ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/bambu.AppImage \
      "https://github.com/bambulab/BambuStudio/releases/download/${BAMBU_VERSION}/${BAMBU_APPIMAGE}" \
 && echo "${BAMBU_SHA256}  /tmp/bambu.AppImage" | sha256sum -c - \
 && chmod +x /tmp/bambu.AppImage \
 && cd /tmp && ./bambu.AppImage --appimage-extract >/dev/null \
 && mv /tmp/squashfs-root /opt/bambu \
 && rm /tmp/bambu.AppImage

COPY requirements.txt /app/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /app/requirements.txt
ENV PATH=/opt/venv/bin:$PATH MPLCONFIGDIR=/tmp/mpl

COPY *.py printer-ca.pem /app/
COPY profiles /app/profiles
# Flatten the system + user presets once at build time (see flatten.py).
RUN P=/opt/bambu/resources/profiles/BBL && mkdir -p /opt/profiles \
 && python3 /app/flatten.py $P machine --system "Bambu Lab P1S 0.4 nozzle" /opt/profiles/machine.json \
 && python3 /app/flatten.py $P filament --system "Bambu PLA Basic @BBL P1S 0.4 nozzle" /opt/profiles/filament.json \
 && python3 /app/flatten.py $P process --user "/app/profiles/user/0.20mm Custom.json" /opt/profiles/process-0.20.json \
 && python3 /app/flatten.py $P process --user "/app/profiles/user/0.08mm Custom.json" /opt/profiles/process-0.08.json

WORKDIR /app
EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "-u", "server.py"]
