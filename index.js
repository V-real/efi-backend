const https = require('https');
const http = require('http');
const { URL } = require('url');

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const certBase64 = process.env.CERT_BASE64;
const certPassword = process.env.CERT_PASSWORD || '';
const port = process.env.PORT || 3000;

// Se quiser forçar homologação/produção por env:
const apiBaseUrl =
  process.env.API_BASE_URL ||
  (process.env.EFI_SANDBOX === 'true'
    ? 'https://pagarcontas-h.api.efipay.com.br'
    : 'https://pagarcontas.api.efipay.com.br');

if (!clientId || !clientSecret || !certBase64) {
  console.error('Faltam variáveis de ambiente obrigatórias: CLIENT_ID, CLIENT_SECRET, CERT_BASE64');
  process.exit(1);
}

const certificado = Buffer.from(certBase64, 'base64');

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function validarCodigoBoleto(codigo) {
  const limpo = onlyDigits(codigo);

  if (!limpo) {
    return { valido: false, motivo: 'codigo_vazio', tamanho: 0 };
  }

  if (limpo.length === 44) {
    return { valido: true, tipo: 'codigo_barras', tamanho: 44, codigo: limpo };
  }

  if (limpo.length === 47) {
    return { valido: true, tipo: 'linha_digitavel', tamanho: 47, codigo: limpo };
  }

  if (limpo.length === 48) {
    return { valido: true, tipo: 'convenio', tamanho: 48, codigo: limpo };
  }

  return {
    valido: false,
    motivo: 'tamanho_invalido',
    tamanho: limpo.length,
    codigo: limpo
  };
}

function fazerRequestJson({ method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method,
      pfx: certificado,
      passphrase: certPassword,
      headers
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data: json
          });
        } catch {
          resolve({
            ok: false,
            status: res.statusCode,
            data: {
              erro: 'resposta_invalida',
              detalhes: data
            }
          });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function gerarToken() {
  return new Promise(async (resolve, reject) => {
    try {
      const body = JSON.stringify({
        grant_type: 'client_credentials'
      });

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const response = await fazerRequestJson({
        method: 'POST',
        url: `${apiBaseUrl}/v1/oauth/token`,
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      });

      if (response.ok && response.data.access_token) {
        resolve(response.data.access_token);
      } else {
        reject({
          erro: 'falha_ao_gerar_token',
          status: response.status,
          detalhes: response.data
        });
      }
    } catch (erro) {
      reject({
        erro: 'erro_request_token',
        detalhes: erro.message || erro
      });
    }
  });
}

function normalizarDetalhesBoleto(data = {}, codigoInformado = '') {
  const banco = data.banco || {};
  const datas = data.datas || {};
  const beneficiario = data.beneficiario || {};
  const pagador = data.pagador || {};
  const valores = data.valores || {};
  const informacoesPagamento = data.informacoesPagamento || {};

  const valorOriginal =
    typeof valores.original === 'number'
      ? Number((valores.original / 100).toFixed(2))
      : null;

  const valorFinal =
    typeof valores.final === 'number'
      ? Number((valores.final / 100).toFixed(2))
      : null;

  const valorAbatimento =
    typeof valores.abatimento === 'number'
      ? Number((valores.abatimento / 100).toFixed(2))
      : null;

  const valorMulta =
    typeof valores.multa === 'number'
      ? Number((valores.multa / 100).toFixed(2))
      : null;

  const valorJuros =
    typeof valores.juros === 'number'
      ? Number((valores.juros / 100).toFixed(2))
      : null;

  const valorDesconto =
    typeof valores.desconto === 'number'
      ? Number((valores.desconto / 100).toFixed(2))
      : null;

  return {
    codigo_barras: data.codBarras || onlyDigits(codigoInformado) || null,
    linha_digitavel: data.linhaDigitavel || null,
    tipo: data.tipo || null,
    banco: {
      codigo: banco.codigo || null,
      nome: banco.nome || null
    },
    vencimento: datas.vencimento || null,
    limite_pagamento: datas.limitePagamento || null,
    beneficiario: {
      nome: beneficiario.nome || null,
      fantasia: beneficiario.fantasia || null,
      documento: beneficiario.documento || null
    },
    pagador: {
      nome: pagador.nome || null,
      documento: pagador.documento || null
    },
    valores: {
      original: valorOriginal,
      abatimento: valorAbatimento,
      multa: valorMulta,
      juros: valorJuros,
      desconto: valorDesconto,
      final: valorFinal
    },
    pode_pagar:
      informacoesPagamento.podeSerPago === undefined
        ? true
        : !!informacoesPagamento.podeSerPago,
    informacoes_pagamento: {
      podeSerPago:
        informacoesPagamento.podeSerPago === undefined
          ? null
          : informacoesPagamento.podeSerPago,
      divergente: informacoesPagamento.divergente || null,
      parcial: informacoesPagamento.parcial || null
    },
    nome_beneficiario:
      beneficiario.nome || beneficiario.fantasia || null,
    valor: valorFinal ?? valorOriginal ?? null
  };
}

async function consultarBoletoReal(codigo) {
  const validacao = validarCodigoBoleto(codigo);

  if (!validacao.valido) {
    return {
      ok: false,
      erro: 'boleto_invalido',
      detalhes: validacao
    };
  }

  const token = await gerarToken();

  const response = await fazerRequestJson({
    method: 'GET',
    url: `${apiBaseUrl}/v1/codBarras/${encodeURIComponent(validacao.codigo)}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      erro: 'erro_consulta_boleto',
      status: response.status,
      detalhes: response.data
    };
  }

  const normalizado = normalizarDetalhesBoleto(response.data, validacao.codigo);

  return {
    ok: true,
    consulta_real: true,
    provider: 'efi',
    codigo_informado: codigo,
    ...normalizado,
    raw: response.data
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('json_invalido'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://localhost:${port}`);

    if (parsedUrl.pathname === '/token' && req.method === 'GET') {
      try {
        const token = await gerarToken();
        sendJson(res, 200, { ok: true, token });
      } catch (erro) {
        sendJson(res, 500, { ok: false, erro });
      }
      return;
    }

    if (parsedUrl.pathname === '/consultar-boleto' && req.method === 'GET') {
      try {
        const codigo =
          parsedUrl.searchParams.get('codigo') ||
          parsedUrl.searchParams.get('codigo_barras') ||
          parsedUrl.searchParams.get('linha_digitavel') ||
          '';

        const resultado = await consultarBoletoReal(codigo);

        if (resultado.ok) {
          sendJson(res, 200, resultado);
        } else {
          sendJson(res, 400, resultado);
        }
      } catch (erro) {
        sendJson(res, 500, {
          ok: false,
          erro: 'erro_interno_consulta_boleto',
          detalhes: erro.message || erro
        });
      }
      return;
    }

    if (parsedUrl.pathname === '/consultar-boleto' && req.method === 'POST') {
      try {
        const body = await readBody(req);

        const codigo =
          body.codigo_barras ||
          body.codigo ||
          body.linha_digitavel ||
          '';

        const resultado = await consultarBoletoReal(codigo);

        if (resultado.ok) {
          sendJson(res, 200, resultado);
        } else {
          sendJson(res, 400, resultado);
        }
      } catch (erro) {
        sendJson(res, 500, {
          ok: false,
          erro:
            erro.message === 'json_invalido'
              ? 'json_invalido'
              : 'erro_interno_consulta_boleto',
          detalhes: erro.message || erro
        });
      }
      return;
    }

    if (parsedUrl.pathname === '/' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: 'efi-token-api',
        rotas: {
          token: 'GET /token',
          consultarBoletoGet: 'GET /consultar-boleto?codigo=...',
          consultarBoletoPost: 'POST /consultar-boleto'
        }
      });
      return;
    }

    sendJson(res, 404, { ok: false, erro: 'rota_nao_encontrada' });
  } catch (erro) {
    sendJson(res, 500, {
      ok: false,
      erro: 'erro_interno_servidor',
      detalhes: erro.message || erro
    });
  }
});

server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
