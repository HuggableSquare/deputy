FROM node:22

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y libpoppler-cpp-dev libpoppler-private-dev

COPY package.json yarn.lock ./

RUN yarn install --production --frozen-lockfile

COPY . .

CMD ["node", "index.js"]
