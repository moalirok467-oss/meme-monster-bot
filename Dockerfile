FROM node:20
WORKDIR /app
COPY package.json .
RUN npm install
COPY trading-bot.js .
CMD ["node", "trading-bot.js"]
