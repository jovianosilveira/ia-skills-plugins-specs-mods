"""Carimba a bio do autor (autor/BIO.md) no README de cada projeto.

A bio fica entre as marcas <!-- BIO:INICIO ... --> e <!-- BIO:FIM -->. O README que já tem as marcas
recebe a bio nova no lugar da antiga; o que não tem recebe a bio no fim. Para mudar a bio, edite só
autor/BIO.md e rode de novo. A foto vem do perfil do GitHub: trocou lá, troca em todos.

    python ferramentas/carimbar_bio.py               # todos os README.md deste repositório
    python ferramentas/carimbar_bio.py OUTRA_PASTA   # os README.md de outra pasta
    python ferramentas/carimbar_bio.py --conferir    # só confere; sai com erro se algum estiver velho

Só README.md: SKILL.md é lido pelo Claude a cada uso, e a bio ali gastaria tokens à toa.
Roda com a biblioteca padrão do Python.
"""
import argparse
import pathlib
import re
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
BIO = RAIZ / 'autor' / 'BIO.md'
INICIO = '<!-- BIO:INICIO: vem de autor/BIO.md pelo ferramentas/carimbar_bio.py; edite lá, não aqui -->'
FIM = '<!-- BIO:FIM -->'
# A linha "---" que as primeiras versões punham antes da bio sai junto: o título "Quem fez" já traz o seu sublinhado.
BLOCO = re.compile(r'(?:^---\n+)?<!-- BIO:INICIO.*?<!-- BIO:FIM -->', re.S | re.M)
# Pastas que não são projeto: o próprio git, dependências, os tipos que o Claude Code gera e as pastas desta ferramenta.
PULAR = {'.git', 'node_modules', '.claude-plugin', 'autor', 'ferramentas'}


def readmes(pasta: pathlib.Path):
    for p in sorted(pasta.rglob('README.md')):
        if not PULAR.intersection(p.relative_to(pasta).parts[:-1]):
            yield p


def carimbar(texto: str, bloco: str) -> str:
    if BLOCO.search(texto):
        return BLOCO.sub(lambda _: bloco, texto, count=1)
    return texto.rstrip('\n') + '\n\n' + bloco + '\n'


def main() -> int:
    ap = argparse.ArgumentParser(description='Carimba autor/BIO.md no README.md de cada projeto.')
    ap.add_argument('pasta', nargs='?', default=str(RAIZ), help='pasta com os projetos (padrão: este repositório)')
    ap.add_argument('--conferir', action='store_true', help='só confere, sem gravar')
    args = ap.parse_args()
    bloco = INICIO + '\n' + BIO.read_text(encoding='utf-8').strip() + '\n' + FIM
    pasta = pathlib.Path(args.pasta).resolve()
    velhos = []
    for p in readmes(pasta):
        texto = p.read_text(encoding='utf-8')
        novo = carimbar(texto, bloco)
        nome = p.relative_to(pasta).as_posix()
        if novo == texto:
            print(f'em dia     {nome}')
            continue
        velhos.append(nome)
        if args.conferir:
            print(f'desatualizado  {nome}')
        else:
            p.write_text(novo, encoding='utf-8', newline='')
            print(f'carimbado  {nome}')
    if args.conferir and velhos:
        print(f'\n{len(velhos)} README sem a bio atual. Rode: python ferramentas/carimbar_bio.py')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
