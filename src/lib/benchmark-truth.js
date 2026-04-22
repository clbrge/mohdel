// Ground truth for test/benchmark.md — Riverbend Mobility Dossier
// Each section defines expected items for recall scoring against model output.

export const people = [
  'Serena', 'Omar', 'Elise', 'Raj', 'Della',
  'Carlene', 'Myles', 'Lena', 'Calvin', 'Farah',
  'Gio', 'Ron', 'Jayden', 'Lucia', 'Tasha'
]

export const organizations = [
  'NST|North Sky Transit',
  'UrbanLift',
  'USDOT'
]

export const locations = [
  'Riverbend',
  'Eastmoor',
  'Pine Hollow',
  'Hawthorne',
  'Pier 7',
  'HarborView|Harbor View'
]

export const metrics = [
  { match: '480', label: '$480M public budget' },
  { match: '515', label: '$515M bond ceiling' },
  { match: '502', label: '$502M NST bid' },
  { match: '468', label: '$468M UrbanLift bid' },
  { match: '120', label: '$120M contingency fund' },
  { match: '96.5', label: '96.5% rail on-time target' },
  { match: '1.9', label: '1.9 incidents/100k current' },
  { match: '2.6', label: '2.6 rider trust current' },
  { match: '3.4', label: '3.4 rider trust target' },
  { match: '35', label: '$35M stadium pledge' }
]

export const contradictions = [
  { id: 'budget', match: ['480', '502', '468', '515'], label: 'budget figures conflict' },
  { id: 'hawthorne', match: ['hawthorne', 'Hawthorne'], label: 'Hawthorne stop status' },
  { id: 'fare', match: ['cpi', 'CPI', 'fare'], label: 'fare policy CPI vs CPI+1.2%' },
  { id: 'mttr', match: ['mttr', 'MTTR', 'repair', '40', '62'], label: 'MTTR values spread' },
  { id: 'safety', match: ['0.8', 'misquot'], label: 'safety target 1.2 vs 0.8 misquote' },
  { id: 'harborline-cost', match: ['210', '260'], label: 'HarborLine cost $210M vs $260M' },
  { id: 'inflation', match: ['inflation', '3.1', '2.6%', '4.4', '3.7'], label: 'inflation assumptions' }
]

export const enums = {
  'summary.tone': ['neutral', 'optimistic', 'pessimistic', 'conflicted'],
  'classifications.sentiment_toward_project': ['positive', 'mixed', 'negative'],
  'classifications.risk_level': ['low', 'medium', 'high'],
  'classifications.financial_risk': ['low', 'medium', 'high'],
  'classifications.data_sensitivity': ['low', 'medium', 'high']
}

export const requiredKeys = [
  'version', 'summary', 'timeline', 'entities', 'classifications',
  'metrics_and_numbers', 'issues', 'action_items', 'contradictions',
  'verification_notes'
]

export const weights = {
  entities: 0.20,
  metrics: 0.25,
  contradictions: 0.25,
  enums: 0.10,
  adherence: 0.20
}
