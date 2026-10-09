# Especificação do Projeto

Crie uma aplicação capaz de monitorar e-mails do Outlook, baixar anexos PDF e extrair informações processuais para uma planilha Excel.

## Objetivo

Automatizar a identificação de informações de processos judiciais recebidos por e-mail.

Já existe na empresa uma automação de protocolos postais que realiza leitura e interpretação de PDFs utilizando OCR, incluindo PDFs nativamente digitais e PDFs digitalizados. Ao projetar esta solução, considere a automação de protocolos postais como referência arquitetural e funcional. Sempre que possível, reutilize a mesma filosofia de processamento documental, estratégias de OCR, validação de dados, tratamento de PDFs digitalizados e mecanismos de extração de informações. A principal diferença é que esta nova solução deverá extrair informações processuais em vez de informações de protocolos postais.

## Fonte dos documentos

- Todos os documentos chegam por Outlook.
- Os documentos são PDFs anexados aos e-mails.
- Cada PDF corresponde a apenas um processo.
- Os PDFs podem possuir OCR.
- Alguns PDFs podem ser apenas imagens escaneadas.
- Casos de OCR ruim existem, mas são raros.

## Informações a extrair

A aplicação deve identificar e preencher:

```text
NOME
NPU
COMARCA
AUDIÊNCIA
HORA
```

## Regras

### NPU

Identificar o número do processo.

Exemplo:

```text
8004835-68.2025.8.05.0044
```

Esse será o identificador principal do processo.

### COMARCA

Identificar a comarca do processo.

Exemplos:

```text
Salvador
Candeias
Feira de Santana
```

### AUDIÊNCIA

Identificar a data da audiência, quando existir.

Exemplos:

```text
15/10/2026
20/11/2026
```

Se não houver audiência:

```text
N/A
```

### HORA

Identificar o horário da audiência.

Exemplos:

```text
10:30
14:00
```

Se não houver audiência:

```text
N/A
```

### NOME

Identificar o nome principal associado ao processo.

A implementação deve permitir configuração futura da regra de identificação do nome.

## Regras de negócio

### Regra 1

Todo PDF representa apenas um processo.

Nunca haverá múltiplos processos em um mesmo PDF.

### Regra 2

Muitos PDFs do mesmo processo podem chegar em momentos diferentes.

Exemplo:

```text
PDF A -> Processo 123
PDF B -> Processo 123
PDF C -> Processo 123
```

### Regra 3

Nem todos os PDFs possuem informações suficientes para identificar o processo.

Alguns documentos complementares podem não possuir:

```text
NPU
Comarca
Dados processuais
```

Nesses casos o documento deve ser ignorado.

Não criar nova linha.

Não atualizar registros existentes.

### Regra 4

Um processo não deve ser duplicado.

Se um NPU já existir:

```text
Atualizar registro existente
```

Ao invés de:

```text
Criar nova linha
```

### Regra 5

Nunca inventar informações.

Caso um campo não possa ser identificado com segurança:

```text
N/A
```

ou

```text
null
```

dependendo da arquitetura escolhida.

## OCR

Implementar estratégia automática:

### Caso 1

PDF possui texto pesquisável.

Extrair diretamente.

### Caso 2

PDF não possui texto.

Executar OCR.

### Caso 3

OCR com baixa confiança.

Marcar para revisão.

A estratégia de OCR deve se inspirar na automação de protocolos postais já existente. Considere que essa automação já é capaz de processar PDFs digitalizados e extrair informações estruturadas. Caso seja possível reutilizar bibliotecas, componentes, fluxos ou padrões utilizados naquele projeto, priorize essa abordagem em vez de criar uma solução completamente nova.

## Excel

Gerar ou atualizar planilha .xlsx.

Colunas:

```text
NOME
NPU
COMARCA
AUDIÊNCIA
HORA
STATUS
```

## Logs

Registrar:

```text
PDF processado
PDF ignorado
PDF com erro
PDF sem NPU
PDF com OCR executado
```

## Arquitetura

Escolha a arquitetura mais robusta possível.

Preferências:

- Node.js
- JavaScript
- Outlook Integration
- ExcelJS
- OCR automático
- Código modular
- Fácil manutenção

## Entregáveis

Forneça:

1. Arquitetura do sistema.
2. Estrutura de pastas.
3. Tecnologias utilizadas.
4. Estratégia de OCR.
5. Estratégia de identificação de duplicidade.
6. Estratégia de extração dos campos.
7. Código completo.
8. Instruções de instalação.
9. Instruções de execução.
10. Estratégias para aumentar a taxa de acerto.

## Qualidade e Confiabilidade

A aplicação deve gerar uma métrica de confiança para cada campo extraído.

Exemplo:

```text
NPU: 99%
COMARCA: 95%
AUDIÊNCIA: 88%
```

Campos abaixo de um limite configurável devem ser marcados para revisão manual.

A solução deve priorizar precisão e confiabilidade. É preferível marcar um documento para revisão do que preencher informações incorretas em um processo. Além disso, considere a automação de protocolos postais como um caso de sucesso já validado na empresa e utilize suas estratégias como referência sempre que aplicável.
