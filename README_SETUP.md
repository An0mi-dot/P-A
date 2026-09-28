# 🚀 SETUP - GUIA COMPLETO

**Para máquinas que não conseguem instalar npm global**

---

## 📋 Resumo

Se você está nessa situação:
- ❌ Não consegue instalar npm globalmente
- ❌ Restrições de permissão na máquina
- ❌ Rede corporativa com proxy
- ❌ Node.js não está no PATH

Use o **setup automático** que baixa Node.js localmente!

---

## 🚀 Opção 1: Batch (Mais Fácil)

### Passo 1: Execute o setup
```bash
# Duplo-clique em:
setup_env.bat

# OU no terminal (cmd):
setup_env.bat
```

### O que ele faz:
1. ✓ Cria pasta `node_bin/`
2. ✓ Baixa Node.js v20.11.0 portável
3. ✓ Extrai em `node_bin/`
4. ✓ Roda `npm install`
5. ✓ Cria `start_dev.bat` para iniciar

### Passo 2: Inicie o app
```bash
# Duplo-clique em:
start_dev.bat

# OU no terminal:
npm start
```

---

## 🔷 Opção 2: PowerShell (Mais Robusta)

### Passo 1: Configure permissões (primeira vez apenas)
```powershell
# Abra PowerShell como Administrador e execute:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Passo 2: Execute o setup
```powershell
# No PowerShell (mesma pasta):
powershell -ExecutionPolicy Bypass -File setup_env.ps1
```

### Passo 3: Inicie o app
```powershell
npm start

# OU use:
.\start_dev.ps1
```

---

## 📥 Opção 3: Download Manual (Se automatizado falhar)

Se os scripts falharem ao baixar Node.js, faça manual:

### Passo 1: Download
- Vá para: https://nodejs.org/dist/v20.11.0/
- Baixe: `node-v20.11.0-win-x64.zip` (64-bit)
- Ou versão 32-bit se sua máquina for antiga: `node-v20.11.0-win-x86.zip`

### Passo 2: Extraia
```
Clique direito → Extrair para:
  → EXTRATJUD\node_bin\
```

Resultado esperado:
```
EXTRATJUD/
├── node_bin/
│   ├── node.exe         ← Tem isso?
│   ├── npm.cmd          ← E isso?
│   └── ... (outros arquivos)
```

### Passo 3: Instale dependências
```bash
# Abra terminal na pasta EXTRATJUD
set PATH=%CD%\node_bin;%CD%\node_bin\node_modules\.bin;%PATH%
npm install
```

### Passo 4: Execute
```bash
npm start
```

---

## ✅ Verificação

Após setup, confirme que tudo funciona:

```bash
# Verificar node
node --version
# Output: v20.11.0 (ou similar)

# Verificar npm
npm --version
# Output: 10.2.0 (ou similar)

# Verificar dependências
npm list
# Output: lista de pacotes instalados
```

---

## 🛠️ Troubleshooting

### "node.exe não encontrado"
```
❌ Problema: Node.js não foi extraído corretamente

✅ Solução:
1. Delete a pasta node_bin/
2. Execute setup_env.bat novamente
3. Se falhar, faça download manual (Opção 3)
```

### "npm install falha"
```
❌ Problema: Falha na instalação de dependências

✅ Solução:
1. Limpe cache: npm cache clean --force
2. Tente novamente: npm install
3. Se persistir, verifique conexão/proxy
```

### "npm start não funciona"
```
❌ Problema: Electron não inicia

✅ Solução:
1. Certifique que npm install foi bem-sucedido
2. Verifique pasta node_modules/ existe
3. Try: npm start (novamente)
4. Se erro persistir, verifique logs em terminal
```

### "Erro de permissão (EACCES, EPERM)"
```
❌ Problema: Sem permissão para criar arquivos

✅ Solução:
1. Execute como Administrador:
   - Clique direito no cmd.exe → Executar como admin
2. Navegue até pasta EXTRATJUD
3. Execute setup novamente
```

### "Proxy corporativo bloqueando download"
```
❌ Problema: Firewall corporativo não permite download

✅ Solução:
1. Configure proxy em .env:
   HTTP_PROXY=http://proxy.empresa.com:8080
   HTTPS_PROXY=http://proxy.empresa.com:8080

2. Configure npm:
   npm config set proxy http://proxy.empresa.com:8080
   npm config set https-proxy http://proxy.empresa.com:8080

3. Tente novamente: setup_env.bat

4. Se ainda falhar, download manual (Opção 3)
```

---

## 📂 Estrutura Criada

Após setup bem-sucedido:

```
EXTRATJUD/
├── node_bin/              ← Node.js local (NÃO versionar!)
│   ├── node.exe
│   ├── npm.cmd
│   └── node_modules/
│
├── node_modules/          ← Dependências (NÃO versionar!)
│   └── (electron, supabase, etc...)
│
├── src/                   ← Código (versionar)
├── public/                ← Frontend (versionar)
├── docs/                  ← Documentação (versionar)
│
├── start_dev.bat          ← Atalho para npm start
├── start_dev.ps1          ← Atalho PowerShell
├── setup_env.bat          ← Este script
├── setup_env.ps1          ← Este script (PS)
│
└── package.json           ← Dependências listadas
```

---

## 🔄 Re-setup (Máquina nova)

Se copiar o projeto para outra máquina:

```bash
# 1. Delete essas pastas:
del /s /q node_bin
del /s /q node_modules

# 2. Execute setup novamente:
setup_env.bat

# 3. Pronto! Tudo funcionará automaticamente
```

---

## 📝 Scripts Disponíveis

```bash
npm start              # Executar app em dev
npm run dev           # Executar com NODE_ENV=development
npm run dist          # Compilar instalador NSIS
npm run bump-version  # Bumpar versão + tag git
npm test              # Executar testes (quando implementado)
```

---

## 🔐 .gitignore

Essas pastas NÃO devem ser versionadas:

```gitignore
# Node
node_bin/
node_modules/

# Logs
*.log
npm-debug.log*
electron-log.txt

# Cache
.cache/
.npm

# Ambiente
.env
.env.local
```

---

## 💡 Dicas

1. **Deixe node_bin/ local**
   - Cada máquina baixa sua própria versão
   - Evita problemas de compatibilidade

2. **Se ficar lento**
   - Aumente timeout no setup_env.bat
   - Verifique conexão internet

3. **Para contribuidores**
   - Sempre execute `setup_env.bat` antes de começar
   - Nunca versione node_bin/ ou node_modules/

4. **Para CI/CD (futuro)**
   - Este setup é manual
   - CI/CD pode automaturar: `npm ci` em Docker

---

## 🆘 Precisa de Ajuda?

Se tiver problemas:

1. Verifique [ANALISE_PROFUNDA_E_LIMPEZA.md](ANALISE_PROFUNDA_E_LIMPEZA.md)
2. Leia [GUIA_RAPIDO_ADMIN.md](docs/GUIA_RAPIDO_ADMIN.md)
3. Abra issue no GitHub com:
   - Windows versão
   - Erro mensagem
   - Saída do: `node --version` e `npm --version`

---

## 📬 Protocolos Postais e Tesseract OCR

O módulo de Protocolos Postais utiliza OCR para leitura e extração de dados (NPUs, partes, comarcas, audiências e ARs) de PDFs digitalizados.

### 1. Detecção Automática do Tesseract
O sistema detecta o Tesseract automaticamente na seguinte ordem:
1. Configuração salva em `config.json` (`tesseract_cmd`) ou selecionada na interface gráfica.
2. Variáveis de ambiente `TESSERACT_CMD` e `TESSERACT_PATH`.
3. Executável no `PATH` do sistema (`where.exe tesseract`).
4. Pasta local do repositório: `bin/tesseract/tesseract.exe`.
5. Instalação de usuário (sem permissão de administrador): `%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe`.
6. Pastas padrão do sistema: `C:\Program Files\Tesseract-OCR\tesseract.exe` (ou em outras unidades C:, D:, E:, F:).

### 2. Uso em Máquinas Corporativas (Sem Admin / UAC)
Se não for possível executar instaladores convencionais:
1. Baixe o instalador do Tesseract (ex.: UB-Mannheim 64-bit).
2. Abra-o com o **7-Zip** e extraia o conteúdo.
3. Mova a pasta extraída para `%LOCALAPPDATA%\Programs\Tesseract-OCR` ou para `bin/tesseract` dentro do projeto.
4. Na tela de Protocolos Postais, você pode também clicar no botão **"Alterar..."** e apontar diretamente para o arquivo `tesseract.exe`.

### 3. Planilha de Fallback (Comarcas e Escritórios)
Se um processo não tiver escritório cadastrado no Espaider, o sistema busca a planilha de comarcas automaticamente em:
- Caminho definido em `config.json` (`fallback_spreadsheet`).
- `Desktop/TRABALHO/*.xlsx` ou na pasta do projeto.

### 4. Configuração de Timeout do Espaider (Spider)
O Spider pode ser lento dependendo da carga do servidor ou VPN. O timeout padrão de consulta foi aumentado para **45 segundos** (anteriormente 20s). Se necessário, você pode configurar um valor personalizado em milissegundos no `config.json`:
```json
{
  "espaider_timeout": 60000
}
```

---

**Status:** ✅ Pronto para usar  
**Compatível com:** Windows 10/11 (64-bit)
