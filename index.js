const https = require('https');
const http = require('http');

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const certBase64 = process.env.CERT_BASE64;
const certPassword = process.env.CERT_PASSWORD || '';
const port = process.env.PORT || 3000;

if (!clientId || !clientSecret || !certBase64) {
  console.error('Faltam variáveis de ambiente obrigatórias: CLIENT_ID, CLIENT_SECRET, CERT_BASE64');
  process.exit(1);
}

const certificado = Buffer.from(certBase64, 'base64');

function gerarToken() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'client_credentials'
    });

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const options = {
      hostname: 'pagarcontas.api.efipay.com.br',
      path: '/v1/oauth/token',
      method: 'POST',
      pfx: certificado,
      passphrase: certPassword,
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (json.access_token) {
            resolve(json.access_token);
          } else {
            reject(json);
          }
        } catch {
          reject({ erro: 'resposta_invalida', detalhes: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/token' && req.method === 'GET') {
    try {
      const token = await gerarToken();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token }));
    } catch (erro) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro }));
    }
    return;
  }

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'efi-token-api' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, erro: 'rota_nao_encontrada' }));
});

server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});