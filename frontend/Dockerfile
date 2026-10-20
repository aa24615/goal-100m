FROM nginx:alpine

# 直接使用本机已构建好的前端产物，构建期无需联网
COPY dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
