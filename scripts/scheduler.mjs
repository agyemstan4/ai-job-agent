const BASE_URL = "http://localhost:3000";

const candidate = {
  name: "Stanley Sarfo Peprah",

  summary:
    "First-Class Honours Software Engineering graduate with practical experience across Kotlin, Java, JavaScript, Firebase, Jetpack Compose and web development. Built VibeNSync as a final-year Android application using Kotlin, Jetpack Compose, Firebase and the Spotify Web API. Also developed a Personal Portfolio Website and other university software projects. Experienced in applying software engineering principles through academic and personal projects.",

  experienceLevel: "Graduate / Junior",

  technicalSkills: [
    "Kotlin",
    "Java",
    "JavaScript",
    "HTML",
    "CSS",
    "SQL",
    "Android Studio",
    "Jetpack Compose",
    "Material Design",
    "MVVM",
    "Firebase",
    "Firebase Firestore",
    "Firebase Authentication",
    "Spotify Web API",
  ],

  matchingSkills: [
    "Kotlin",
    "Java",
    "JavaScript",
    "Android Studio",
    "Jetpack Compose",
    "Firebase",
    "SQL",
  ],

  missingSkills: [],

  strengths: [
    "First-Class Honours Software Engineering degree",
    "Multiple software engineering projects",
    "Android development with Kotlin and Jetpack Compose",
  ],

  growthAreas: [
    "Commercial software engineering experience",
    "Broader backend technologies",
  ],
};

async function run() {
  console.log("\n========================================");
  console.log("🤖 AI JOB AGENT SCHEDULER");
  console.log("========================================\n");

  // -----------------------------------------
  // 1. FETCH NEW JOBS
  // -----------------------------------------

  console.log("🔎 Fetching new jobs...");

  const jobsResponse = await fetch(`${BASE_URL}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role: "junior software engineer",
      location: "London",
    }),
  });

  if (!jobsResponse.ok) {
    throw new Error(
      `Job API failed: ${jobsResponse.status} ${await jobsResponse.text()}`
    );
  }

  const jobs = await jobsResponse.json();

  console.log(`✅ New jobs found: ${jobs.length}`);

  if (!jobs.length) {
    console.log("\nℹ️ No new jobs to process.");
    return;
  }

  // -----------------------------------------
  // 2. MATCH JOBS
  // -----------------------------------------

  console.log("\n🧠 Sending jobs to matching engine...");

  const matchResponse = await fetch(`${BASE_URL}/api/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      candidate,
      jobs,
    }),
  });

  if (!matchResponse.ok) {
    throw new Error(
      `Match API failed: ${matchResponse.status} ${await matchResponse.text()}`
    );
  }

  const matchData = await matchResponse.json();

  const matches = matchData.matches || [];

  console.log(`\n✅ Matching complete: ${matches.length} matches\n`);

  // -----------------------------------------
  // 3. DISPLAY RESULTS
  // -----------------------------------------

  console.log("========================================");
  console.log("🔥 JOB MATCHES");
  console.log("========================================");

  matches.forEach((job, index) => {
    console.log(`\n${index + 1}. ${job.title}`);
    console.log(`   Company: ${job.company}`);
    console.log(`   Location: ${job.location}`);
    console.log(`   Match: ${job.matchScore}%`);
    console.log(`   Reason: ${job.reason}`);
    console.log(`   URL: ${job.url}`);
  });

  console.log("\n========================================");
  console.log("🏁 SCHEDULER RUN COMPLETE");
  console.log("========================================\n");
}

run().catch((error) => {
  console.error("\n❌ SCHEDULER FAILED");
  console.error(error);
  process.exit(1);
});