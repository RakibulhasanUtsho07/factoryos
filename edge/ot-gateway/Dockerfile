FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    npm_config_audit=false \
    npm_config_fund=false
WORKDIR /opt/factoryos-ot-gateway

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /var/lib/factoryos-ot/pki \
    && chown -R node:node /opt/factoryos-ot-gateway /var/lib/factoryos-ot

COPY --chown=node:node src ./src
USER node
EXPOSE 8443
VOLUME ["/var/lib/factoryos-ot"]
HEALTHCHECK --interval=20s --timeout=4s --start-period=30s --retries=3 \
  CMD node -e "const https=require('node:https');const req=https.get('https://127.0.0.1:8443/healthz',{rejectUnauthorized:false,timeout:2500},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1)})"
CMD ["node", "src/index.mjs"]
