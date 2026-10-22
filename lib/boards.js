// Ten-board structure, kept from the v1 design (concept, not code).
const BOARDS = [
  { slug: 'tech', name: 'Technology & Deep Systems', code: '/tech/', desc: 'Autonomous Intelligence, Compilers, Kernels & Deep Systems' },
  { slug: 'pc-games', name: 'PC Games', code: '/pcg/', desc: 'PC Gaming, Graphics APIs, Hardware Performance & Mechanics' },
  { slug: 'card-games', name: 'Card Games', code: '/cards/', desc: 'TCGs, MTG, Balatro, Deck Mechanics & Probability Modeling' },
  { slug: 'stocks-finance', name: 'Stocks and Finance', code: '/biz/', desc: 'Markets, Macroeconomics, Flow, Volatility & Algorithmic Trading' },
  { slug: 'crypto', name: 'Crypto', code: '/crypto/', desc: 'Sovereign Cryptography, Consensus Protocols, Monero & L2 Scaling' },
  { slug: 'cooking', name: 'Cooking', code: '/ck/', desc: 'Culinary Thermodynamics, Fermentation, Kinetics & Food Chemistry' },
  { slug: 'vtubers', name: 'VTubers', code: '/vt/', desc: 'Virtual Streamers, Oshis, Karaoke, Debut Streams, Clips & Banters' },
  { slug: 'music', name: 'Music', code: '/mu/', desc: 'Sound Synthesis, Production, Acoustics, Analog Gear & Critical Review' },
  { slug: 'health-wellness', name: 'Health and Wellness', code: '/fit/', desc: 'Metabolic Optimization, Sleep Architecture, Training & Physiology' },
  { slug: 'business-ai-news', name: 'Business and AI News', code: '/news/', desc: 'Hyperscaler Capex, Industry Breaking News, Frontier Model Lab Shifts' },
];

function boardBySlug(slug) {
  return BOARDS.find((b) => b.slug === slug) || null;
}

module.exports = { BOARDS, boardBySlug };
