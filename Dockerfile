# Базовий образ із повною Debian (не slim), щоби зібрати native модулі
FROM node:20-bookworm

# Залежності для збірки mediasoup + ffmpeg для запису
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./server.js
COPY public ./public

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
 CMD node -e "fetch('http://127.0.0.1:3000/rtp-capabilities').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

EXPOSE 3000/tcp
EXPOSE 40000/tcp
EXPOSE 40000/udp

ENV PORT=3000
ENV RTP_PORT=40000
# ENV ANNOUNCED_IP=203.0.113.10
# Куди зберігати записи всередині контейнера (примапимо volume):
ENV RECORD_DIR=/recordings

CMD ["npm", "start"]
