FROM node:24-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

CMD ["sh", "-c", "if [ -n \"$GITHUB_TOKEN\" ]; then printf '//api.github.com/:_authToken=%s\n' \"$GITHUB_TOKEN\" > /root/.npmrc; fi; exec npm start"]
