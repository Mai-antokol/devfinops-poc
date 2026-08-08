FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY jira-listener.js .
EXPOSE 4000
CMD ["node", "jira-listener.js"]
