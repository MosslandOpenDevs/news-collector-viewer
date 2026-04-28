import { summarizeArticleRuleBased } from "../utils/articleSummary.js";

const samples = [
  {
    id: "case-01",
    type: "product_launch_with_metrics",
    title: "NVIDIA launches enterprise agent runtime with cost controls",
    rawText: `
      NVIDIA announced a new enterprise runtime for AI agents at its developer event.
      The company said pilot customers reduced serving cost by 28% and improved latency by 19%.
      The stack adds policy checks, rollout templates, and production observability.
      General availability is planned for Q3 with broader partner integrations.
      Subscribe now for more updates.
    `,
  },
  {
    id: "case-02",
    type: "funding_news",
    title: "AI workflow startup raises $42M Series B",
    rawText: `
      Workflow startup OrbitFlow raised a $42 million Series B led by NorthBridge Ventures.
      OrbitFlow said the funding will be used to expand enterprise deployment and hiring.
      The startup currently serves 320 customers across healthcare and finance sectors.
      The company plans to open a second data center in 2027.
    `,
  },
  {
    id: "case-03",
    type: "policy_update",
    title: "EU publishes draft AI procurement guidance for public agencies",
    rawText: `
      The European Commission published draft guidance for AI procurement in public institutions.
      The draft introduces mandatory model documentation and incident reporting requirements.
      Agencies above 250 employees must complete annual risk audits starting next year.
      A consultation period will run until July before the final text is issued.
    `,
  },
  {
    id: "case-04",
    type: "opinion_like_low_signal",
    title: "Why AI will change everything forever",
    rawText: `
      This trend could reshape how people think about work in the long run.
      Some observers expect a dramatic shift across all industries.
      Experts said this might become a game changer.
      The debate is likely to continue for years.
    `,
  },
  {
    id: "case-05",
    type: "quote_heavy_report",
    title: "Cloud vendor discusses model roadmap with enterprise clients",
    rawText: `
      "We are very excited about the future," the executive said during a media session.
      "Our customers are also excited," another spokesperson noted.
      The company announced a phased migration plan and confirmed support for on-prem deployments.
      It expects to complete migration for 40 enterprise clients by December.
    `,
  },
  {
    id: "case-06",
    type: "duplicate_sentences_noise",
    title: "Retail platform expands AI assistant rollout",
    rawText: `
      The retailer expanded its AI assistant rollout to 1,200 stores nationwide.
      The retailer expanded its AI assistant rollout to 1,200 stores nationwide.
      The update includes multilingual support and inventory alerts.
      The update includes multilingual support and inventory alerts.
      The company targets 95% same-day response coverage.
    `,
  },
  {
    id: "case-07",
    type: "short_thin_article",
    title: "Startup previews assistant",
    rawText: `
      A startup previewed an assistant.
      More details will follow.
    `,
  },
  {
    id: "case-08",
    type: "security_incident",
    title: "Enterprise model gateway patches token leak issue",
    rawText: `
      Security researchers disclosed a token leakage issue in a model gateway product.
      The vendor released patch 2.4.1 and urged customers to rotate keys within 24 hours.
      The company said no customer prompts were exposed in confirmed incidents.
      It also added stricter key scoping and audit logs by default.
    `,
  },
  {
    id: "case-09",
    type: "research_result",
    title: "University team reports 14% gain on multilingual reasoning benchmark",
    rawText: `
      A university research team released a paper on multilingual reasoning improvements.
      The team reported a 14% score gain on a 12-language benchmark over a strong baseline.
      The method combines sparse routing with curriculum fine-tuning.
      The authors open-sourced training scripts and evaluation prompts.
    `,
  },
  {
    id: "case-10",
    type: "promotional_copy",
    title: "Join our AI summit this week",
    rawText: `
      Register now.
      Subscribe now.
      Early bird tickets.
      Save your spot today.
    `,
  },
];

function printCase(resultRow) {
  console.log("=".repeat(80));
  console.log(`[${resultRow.id}] ${resultRow.type}`);
  console.log(`title: ${resultRow.title}`);
  console.log(
    `qualityScore=${resultRow.qualityScore} shouldSkip=${resultRow.shouldSkip} usedFallback=${resultRow.usedFallback}`,
  );
  console.log(`summary: ${resultRow.summary}`);
  console.log(`selectedSentences: ${JSON.stringify(resultRow.selectedSentences)}`);
  console.log(`topReasons:`);
  for (const row of resultRow.topScored) {
    console.log(`- score=${row.score} sentence="${row.sentence}" reasons=${JSON.stringify(row.reasons)}`);
  }
}

const rows = samples.map((sample) => {
  const result = summarizeArticleRuleBased({
    title: sample.title,
    rawText: sample.rawText,
    lang: "en",
  });

  return {
    id: sample.id,
    type: sample.type,
    title: sample.title,
    qualityScore: result.qualityScore,
    shouldSkip: result.shouldSkip,
    usedFallback: result.usedFallback,
    summary: result.summary,
    selectedSentences: result.debug?.selectedSentences || [],
    topScored: result.debug?.topScored || [],
  };
});

rows.forEach(printCase);

const distribution = {
  high_80_plus: rows.filter((r) => r.qualityScore >= 80).length,
  mid_60_79: rows.filter((r) => r.qualityScore >= 60 && r.qualityScore < 80).length,
  low_40_59: rows.filter((r) => r.qualityScore >= 40 && r.qualityScore < 60).length,
  skip_below_40: rows.filter((r) => r.qualityScore < 40 || r.shouldSkip).length,
};

console.log("=".repeat(80));
console.log("distribution:", JSON.stringify(distribution));
