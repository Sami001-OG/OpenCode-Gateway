FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY plugin.js ./
ENV WORK_DIR=/work OPENCODE_PORT=4096
EXPOSE 4096
CMD ["node", "src/index.js"]
