FROM rockylinux:9

# Node.js 22 is required by current mediasoup releases.
RUN dnf -y install dnf-plugins-core curl openssl \
  && dnf -y module disable nodejs \
  && dnf -y install https://rpm.nodesource.com/pub_22.x/nodistro/repo/nodesource-release-nodistro-1.noarch.rpm \
  && dnf -y install nodejs gcc-c++ make python3 \
  && dnf clean all

WORKDIR /app

COPY package.json /app/package.json
COPY server/package.json /app/server/package.json
RUN npm install

COPY server /app/server
COPY client /app/client

RUN mkdir -p /app/data /app/certs
EXPOSE 8443/tcp 40000-40100/udp
CMD ["npm", "--workspace", "server", "start"]
