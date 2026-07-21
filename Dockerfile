FROM node:22-slim

RUN apt-get update && \
    apt-get install -y ffmpeg fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY worker.js ./

CMD ["node", "worker.js"]
