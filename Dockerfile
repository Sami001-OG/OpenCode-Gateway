FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install -g opencode-ai@1.19.6
COPY src/ ./src/
COPY plugin.js ./
ENV WORK_DIR=/work OPENCODE_PORT=4096
EXPOSE 4096
CMD ["node", "src/index.js"]
