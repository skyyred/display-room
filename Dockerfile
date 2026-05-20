FROM rockylinux:9

# mediasoup currently requires Node.js >=22.
RUN dnf -y install curl-minimal openssl ca-certificates gcc-c++ make python3 python3-pip tar xz \
  && dnf clean all

ARG NODE_VERSION=22.15.1
RUN arch="$(uname -m)" \
  && case "$arch" in \
    x86_64) nodeArch='x64' ;; \
    aarch64) nodeArch='arm64' ;; \
    *) echo "Unsupported architecture: $arch"; exit 1 ;; \
  esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodeArch}.tar.xz" -o /tmp/node.tar.xz \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  && rm -f /tmp/node.tar.xz \
  && node --version \
  && npm --version

WORKDIR /app

COPY package.json /app/package.json
COPY server/package.json /app/server/package.json
COPY tools /app/tools
RUN npm install

COPY server /app/server
COPY client /app/client

RUN mkdir -p /app/data /app/certs
EXPOSE 8443/tcp 40000-40100/udp
CMD ["npm", "--workspace", "server", "start"]
