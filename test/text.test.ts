import { describe, expect, it } from 'vitest';
import {
  findMatchingKeyword,
  normalizeText,
  parseKeywords,
  pickVariationIndex,
  renderReply,
  utf8ByteLength,
} from '../src/lib/text.js';

describe('normalizeText', () => {
  it('remove acentos, baixa caixa e colapsa espaços', () => {
    expect(normalizeText('  Eu   QUERO  Promoção ')).toBe('eu quero promocao');
  });
});

describe('findMatchingKeyword', () => {
  const keywords = ['EU QUERO', 'link', 'preço'];

  it('casa frase inteira ignorando acentos e caixa', () => {
    expect(findMatchingKeyword('eu quero!!! 😍', keywords)).toBe('EU QUERO');
    expect(findMatchingKeyword('Qual o PRECO?', keywords)).toBe('preço');
    expect(findMatchingKeyword('me manda o Link', keywords)).toBe('link');
  });

  it('não casa dentro de outra palavra', () => {
    expect(findMatchingKeyword('me segue no linkedin', keywords)).toBeNull();
    expect(findMatchingKeyword('preçoso', keywords)).toBeNull();
  });

  it('ignora palavras-chave vazias e texto sem correspondência', () => {
    expect(findMatchingKeyword('lindo post', ['', '  '])).toBeNull();
    expect(findMatchingKeyword('lindo post', keywords)).toBeNull();
  });
});

describe('renderReply', () => {
  it('substitui {usuario} pela menção', () => {
    expect(renderReply('Oi {usuario}, te mandei no direct!', 'maria')).toBe('Oi @maria, te mandei no direct!');
  });

  it('remove o marcador quando não há username', () => {
    expect(renderReply('Oi {usuario} te mandei no direct!', null)).toBe('Oi te mandei no direct!');
  });

  it('preserva quebras de linha e substitui {usuario} em templates multilinha', () => {
    expect(renderReply('Oi {usuario}!\n\nAqui está o link', 'maria')).toBe('Oi @maria!\n\nAqui está o link');
  });

  it('colapsa o espaço duplo deixado pelo marcador removido, sem tocar nas quebras de linha', () => {
    expect(renderReply('Oi {usuario} tudo', null)).toBe('Oi tudo');
    expect(renderReply('Oi {usuario}\n\nTudo bem', null)).toBe('Oi\n\nTudo bem');
  });

  it('não interpreta padrões especiais de substituição no username', () => {
    expect(renderReply('Oi {usuario}', '$&x')).toBe('Oi @$&x');
  });
});

describe('pickVariationIndex', () => {
  it('nunca repete a última variação quando há alternativas', () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(pickVariationIndex(3, 1, () => r)).not.toBe(1);
    }
  });

  it('retorna 0 quando há apenas uma variação e falha sem variações', () => {
    expect(pickVariationIndex(1, 0, () => 0.5)).toBe(0);
    expect(() => pickVariationIndex(0, null, () => 0.5)).toThrow();
  });
});

describe('utf8ByteLength', () => {
  it('conta bytes, não caracteres', () => {
    expect(utf8ByteLength('ação')).toBe(6);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});

describe('parseKeywords', () => {
  it('separa por vírgula ou quebra de linha e remove duplicatas equivalentes', () => {
    expect(parseKeywords('EU QUERO, link\nLink ,  , preço')).toEqual(['EU QUERO', 'link', 'preço']);
  });
});
