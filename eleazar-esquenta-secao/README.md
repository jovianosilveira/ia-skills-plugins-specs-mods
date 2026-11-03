# Eleazar, o esquenta-sessão

`eleazar-esquenta-secao` é uma mod do Claude Code que mantém o cache da conversa quente enquanto você está parado, mostra embaixo da caixa de mensagem em que pé ele está e avisa o preço antes de você mandar uma mensagem com o cache frio.

Esta é uma amostra daquilo que curamos, adaptamos e criamos na [Mentoria Fábrica de Apps](https://www.joviano.com/vitrine/mentoria-fabrica).

## O problema

O Claude Code guarda a conversa num cache. Enquanto o cache está vivo, cada mensagem nova lê o contexto de lá, pelo preço de leitura, que é baixo. Quando o cache expira, a próxima mensagem precisa escrever o contexto inteiro de novo, pelo preço de escrita, que é dezenas de vezes maior.

Quanto tempo o cache vive:

- **1 hora** na conversa principal, para quem usa o Claude Code pela assinatura;
- **5 minutos** para quem usa créditos, chave de API ou um provedor de nuvem, a não ser que `promptCacheTtl` esteja em `"1h"`.

Ou seja: você para para almoçar, volta, manda "continua" e paga para reescrever a conversa toda. Ninguém avisa.

Um exemplo, pelos preços de tabela que a mod usa (outubro de 2026), numa conversa de 200 mil tokens no Fable 5.1:

| Situação | Custo da próxima mensagem |
| --- | --- |
| Cache quente: o contexto é lido | cerca de US$ 0,05 |
| Cache frio: o contexto é reescrito | cerca de US$ 4,00 |

Na assinatura isso não vira cobrança em dólar: vira consumo do seu limite de uso. O dólar aqui é só a régua.

## A solução

A mod faz três coisas.

**1. Mantém o cache quente.** Depois de 50 minutos sem mensagem, ela manda uma requisição curtinha ao modelo, que lê o contexto do cache e renova a vida dele por mais uma hora. Faz isso até 6 horas depois da sua última mensagem e para. Cada aquecimento também custa: no exemplo acima, uns US$ 0,05.

**2. Mostra o estado o tempo todo.** Embaixo da caixa de mensagem:

| O que aparece | Quer dizer |
| --- | --- |
| 🌡️ **esquentador ligado** · começa depois da sua próxima mensagem | Sessão nova, ainda não há o que aquecer. |
| 🔥 **quente** · reaquece em 38 min | O cache está quente; a contagem anda sozinha até o próximo aquecimento. |
| 🔥 **quente** · reaquece em instantes | O aquecimento sai no próximo minuto. |
| 🧊 **cache frio** · a próxima mensagem custa US$ 4,01 para reaquecer | O cache já foi; você sabe o preço antes de mandar. |
| ⏸️ **esquentador pausado** | A conta usa cache de 5 minutos, que aquecer a cada 50 minutos não segura. |
| ⚠️ **esquentador parou** | Um aquecimento falhou; o motivo vem na linha, e ele volta depois da sua próxima mensagem. |

No app desktop o estado fica na linha de status, à direita, ao lado do nome do modelo. No terminal, fica na linha de dica, à esquerda.

**3. Avisa antes da mensagem cara.** Se o cache esfriou e reescrever vai custar US$ 1 ou mais, a mensagem vai com uma linha dizendo quanto ela vai custar e quanto custaria com o cache quente. Se preferir, a mod pode segurar a mensagem uma vez para você decidir: aí basta mandar de novo para seguir.

## Bê-á-bá: instalar

Precisa do Claude Code 2.1.287 ou mais novo.

**No app desktop (aba Code):** clique no **+** ao lado da caixa de mensagem, abra **Plugins**, adicione o marketplace `jovianosilveira/ia-skills-plugins-specs-mods` e depois adicione o plugin `eleazar-esquenta-secao`.

**Numa sessão do Claude Code no terminal:**

```
/plugin install eleazar-esquenta-secao --marketplace jovianosilveira/ia-skills-plugins-specs-mods
```

Responda `y` para adicionar o marketplace e escolha o escopo de usuário com Enter.

**Pelo terminal do sistema:**

```bash
claude plugin install eleazar-esquenta-secao --marketplace jovianosilveira/ia-skills-plugins-specs-mods
```

Se você tiver o `cache-tax` original instalado, desinstale: os dois juntos dão dois avisos e dois aquecimentos para a mesma pausa.

## Bê-á-bá: usar

1. Abra uma sessão nova. Embaixo da caixa de mensagem aparece **🌡️ esquentador ligado**.
2. Mande uma mensagem qualquer. Quando a resposta chegar, aparece **🔥 quente · reaquece em 50 min**, e a contagem desce sozinha.
3. Pode sair. Se você ficar mais de 50 minutos parado, a mod aquece o cache e a contagem recomeça.
4. Quer ver os números? Digite `/esquentador`. Aparece um cartão com o tamanho do contexto, quanto custaria reaquecer frio, quanto custa cada aquecimento e quantos aquecimentos custam o mesmo que um reaquecimento frio.

Comandos:

| Comando | O que faz |
| --- | --- |
| `/esquentador` | Mostra o cartão com o estado e os preços. |
| `/esquentador desligar` | Desliga nesta sessão e nas próximas. |
| `/esquentador ligar` | Liga de novo, em toda sessão. |
| `/esquentador 90m` | Abre uma janela de 90 minutos (`/esquentador 90m a cada 2m` serve para testar). |
| `/esquentador aviso avisar` | A mensagem com o cache frio passa, com o preço mostrado (é o padrão). |
| `/esquentador aviso segurar` | A mensagem com o cache frio é segurada uma vez; mandou de novo, ela passa. |
| `/esquentador aviso 2` | O aviso só aparece quando reescrever custar US$ 2 ou mais (o padrão é US$ 1). |

Para desinstalar:

```bash
claude plugin uninstall eleazar-esquenta-secao
```

## O que ela não faz

- Não é de graça: cada aquecimento lê o contexto e gasta tokens. O cartão do `/esquentador` mostra a conta para você decidir.
- Não segura cache de 5 minutos. Nessas contas ela pausa e só avisa o preço.
- Não aquece para sempre: para 6 horas depois da sua última mensagem.
- Os valores em dólar são estimativas pela tabela de preços embutida no código, que pode ficar desatualizada.
- No app desktop, nos nossos testes, a linha de dica do lado esquerdo não mostrou o que a mod desenhou nela. Por isso, lá, o estado fica do lado direito.

## Por que Eleazar

No método GENESIS, da Mentoria Fábrica de Apps, os ajudantes levam nomes de personagens bíblicos: Arão faz os vídeos, José planeja, Salomão monta o time.

Eleazar era filho de Arão e sacerdote, e cuidava do azeite da luz do santuário (Números 4:16). A regra do altar, em Levítico 6:12-13, é que o fogo tinha que arder sem parar: toda manhã o sacerdote punha lenha nele, para que nunca se apagasse.

É o que esta mod faz com o cache: põe lenha antes que o fogo apague.

## De onde veio

A mod parte do [cache-tax](https://github.com/karanb192/cache-tax), de Karan Bansal (licença MIT, versão e4940af). O que foi adaptado e criado aqui:

- descobre se o cache da conta vive 1 hora ou 5 minutos, pelas configurações e pelo que as próprias mensagens mostram, em vez de supor 1 hora;
- o aviso vai por dólar (a partir de US$ 1) e só mostra o preço, em vez de barrar a mensagem;
- vem ligada em toda sessão, sem precisar chamar nada;
- o estado fica embaixo da caixa de mensagem, em português, com a contagem até o próximo aquecimento;
- um comando só, `/esquentador`, em português.

O código e os 166 testes estão nesta pasta. Para rodar os testes: `claude plugin test eleazar-esquenta-secao`.
