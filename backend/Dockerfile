FROM node:20-alpine

WORKDIR /app

# 直接使用本机已安装好的依赖，构建期无需联网拉取 npm 源
COPY package.json ./
COPY node_modules ./node_modules
COPY src ./src

EXPOSE 3001
CMD ["node", "src/index.js"]
