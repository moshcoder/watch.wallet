import { describe, expect, test } from 'bun:test'
import { parseCoinpayPaste } from '../src/paste.ts'

const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
const EVM = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const EVM2 = '0x000000000000000000000000000000000000dEaD'
const SOL = 'So11111111111111111111111111111111111111112'

describe('CoinPay "Copy All Addresses" paste', () => {
  test('the plain copy: one watch per chain + address, tokens fold into it', () => {
    const text = [`BTC: ${BTC}`, `ETH: ${EVM.toUpperCase().replace('0X', '0x')}`, `USDC_ETH: ${EVM}`, `USDT: ${EVM}`, `POL: ${EVM}`, `USDC_POL: ${EVM}`, `SOL: ${SOL}`, `USDC_SOL: ${SOL}`, `USDC_BASE: ${EVM2}`].join('\n')
    const r = parseCoinpayPaste(text)
    expect(r.invalid).toEqual([])
    expect(r.unsupported).toEqual([])
    expect(r.watches).toEqual([
      { chain: 'bitcoin', address: BTC, label: 'CoinPay BTC', symbols: ['BTC'] },
      { chain: 'ethereum', address: EVM, label: 'CoinPay ETH, USDC_ETH, USDT', symbols: ['ETH', 'USDC_ETH', 'USDT'] },
      { chain: 'polygon', address: EVM, label: 'CoinPay POL, USDC_POL', symbols: ['POL', 'USDC_POL'] },
      { chain: 'solana', address: SOL, label: 'CoinPay SOL, USDC_SOL', symbols: ['SOL', 'USDC_SOL'] },
      { chain: 'base', address: EVM2.toLowerCase(), label: 'CoinPay USDC_BASE', symbols: ['USDC_BASE'] },
    ])
  })

  test('"Include all fields" labels, CRLF, blank lines and stray spaces', () => {
    const r = parseCoinpayPaste(`\r\n  BTC (Cold (vault)): ${BTC}  \r\nusdc_eth (Treasury):${EVM}\r\nETH: ${EVM}\r\n\r\n`)
    expect(r.watches.map((w) => [w.chain, w.label])).toEqual([['bitcoin', 'Cold (vault)'], ['ethereum', 'Treasury']])
  })

  test('chains we cannot read are reported; junk and wrong-chain addresses are invalid', () => {
    const r = parseCoinpayPaste([`BCH: qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a`, `USDT_TRON: TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf`, `XRP: rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh`, `DOGE: D7Y55`, `FOO: bar`, `SOL: ${EVM}`, `BTC: bc1qnotreal`, 'just some text', `ETH ${EVM}`].join('\n'))
    expect(r.watches).toEqual([])
    expect(r.unsupported).toEqual(['BCH', 'USDT_TRON', 'XRP', 'DOGE', 'FOO'])
    expect(r.invalid).toEqual([`SOL: ${EVM}`, 'BTC: bc1qnotreal', 'just some text', `ETH ${EVM}`])
  })
})
