import { summarizeArticleRuleBased } from "../utils/articleSummary.js";
import { mockArticles } from "../utils/articleSummary.mockData.js";

for (const article of mockArticles) {
  const result = summarizeArticleRuleBased({
    title: article.title,
    rawText: article.rawText,
    lang: /[A-Za-z]/.test(article.title) && !/[가-힣]/.test(article.title) ? "en" : "ko",
  });

  console.log("=".repeat(60));
  console.log(`[${article.id}] ${article.title}`);
  console.log(`qualityScore=${result.qualityScore} usedFallback=${result.usedFallback} shouldSkip=${result.shouldSkip}`);
  console.log(`summary=${result.summary}`);
  console.log(`selectedSentences=${JSON.stringify(result.debug?.selectedSentences || [], null, 2)}`);
}

