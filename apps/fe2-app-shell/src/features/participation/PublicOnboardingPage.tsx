// オンボーディング案内の PUBLIC ページ (/onboarding)。新しく入った人はまだアプリの
// アカウントを持っていないので、/participate と同じくシェルの外 (RequireAuth の外) に置く。
// 最初に所属チームを選んでもらい、管理タブで並べた「やること」の後ろに、全体ミーティングと
// そのチームのミーティングを「いつ・どのリンクに入るか」として続ける (カレンダー招待は送らない)。
// 選んだチームは ?team= に残し、再読み込みや URL の共有でも同じ表示になるようにする。
import { useState } from "react";
import { Button, EmptyState, ErrorState, SkeletonList } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { ParticipationProvider } from "./ParticipationProvider.tsx";
import { usePublicOnboardingItems } from "./hooks.ts";
import type { OnboardingGuide, OnboardingMeeting, OnboardingTeam } from "./contracts.ts";
import styles from "./participation.module.css";

/** チーム未定を選んだときの ?team= の値。 */
const NO_TEAM = "none";

export function PublicOnboardingPage({ api }: { api: ApiClient }): JSX.Element {
  return (
    <ParticipationProvider api={api}>
      <div className={styles.publicPage} data-testid="onboarding-public-page">
        <div className={styles.publicInner}>
          <header className={styles.publicHeader}>
            <h1 className={styles.publicTitle}>はじめにやること</h1>
            <p className={styles.publicLead}>
              運営メンバーへようこそ。まず所属するチームを選んで、表示された項目を上から順に進めてください。
            </p>
          </header>
          <OnboardingGuideView />
        </div>
      </div>
    </ParticipationProvider>
  );
}

function readTeamParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("team");
}

function writeTeamParam(team: string | null): void {
  const url = new URL(window.location.href);
  if (team) url.searchParams.set("team", team);
  else url.searchParams.delete("team");
  window.history.replaceState(window.history.state, "", url);
}

function OnboardingGuideView(): JSX.Element {
  const guide = usePublicOnboardingItems();
  const [team, setTeamState] = useState<string | null>(readTeamParam);
  const setTeam = (next: string | null): void => {
    setTeamState(next);
    writeTeamParam(next);
  };

  if (guide.isLoading) return <SkeletonList rows={3} testId="onboarding-public-loading" />;
  if (guide.isError || !guide.data) {
    const display = ApiError.isApiError(guide.error)
      ? toDisplayableError(guide.error)
      : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
    return <ErrorState error={display} onRetry={() => void guide.refetch()} />;
  }

  const { teams } = guide.data;
  // 消えたチームの ?team= は未選択に戻す。チームが 1 つも無ければ選択自体を省く。
  const picked = teams.find((t) => t.id === team) ?? null;
  if (teams.length > 0 && picked === null && team !== NO_TEAM) {
    return <TeamPicker teams={teams} onPick={setTeam} />;
  }
  return (
    <div className={styles.publicGuide}>
      {teams.length > 0 ? (
        <div className={styles.pickedTeam} data-testid="onboarding-public-picked">
          <span>
            所属チーム: <strong>{picked ? picked.name : "まだ決まっていない"}</strong>
          </span>
          <Button size="sm" variant="secondary" onClick={() => setTeam(null)} testId="onboarding-public-change-team">
            選び直す
          </Button>
        </div>
      ) : null}
      <OnboardingSteps guide={guide.data} team={picked} />
    </div>
  );
}

function TeamPicker({ teams, onPick }: { teams: OnboardingTeam[]; onPick: (team: string) => void }): JSX.Element {
  return (
    <section className={styles.teamPicker} aria-labelledby="onboarding-team-heading" data-testid="onboarding-public-team-picker">
      <h2 id="onboarding-team-heading" className={styles.publicStepTitle}>
        所属するチームを選んでください
      </h2>
      <p className={styles.sectionHint}>選んだチームのミーティングの日時と参加リンクが表示されます。</p>
      <div className={styles.teamChoices}>
        {teams.map((t) => (
          <button
            key={t.id}
            type="button"
            className={styles.teamChoice}
            onClick={() => onPick(t.id)}
            data-testid={`onboarding-public-team-${t.id}`}
          >
            <span className={styles.teamDot} style={t.color ? { background: t.color } : undefined} aria-hidden />
            {t.name}
          </button>
        ))}
        <button
          type="button"
          className={styles.teamChoice}
          onClick={() => onPick(NO_TEAM)}
          data-testid="onboarding-public-team-none"
        >
          まだ決まっていない
        </button>
      </div>
    </section>
  );
}

interface Step {
  key: string;
  title: string;
  description: string | null;
  url: string | null;
  /** ミーティングの日時 (自由記述)。 */
  when?: string;
  linkLabel?: string;
}

function OnboardingSteps({ guide, team }: { guide: OnboardingGuide; team: OnboardingTeam | null }): JSX.Element {
  const all = guide.meetings.find((m) => m.teamId === null);
  const own = team ? guide.meetings.find((m) => m.teamId === team.id) : undefined;
  const steps: Step[] = guide.items.map((i) => ({ key: i.id, title: i.title, description: i.description, url: i.url }));
  if (all) steps.push(meetingStep("all", "次回の全体ミーティングに出る", all));
  if (team) {
    const title = `${team.name}のチームミーティングに出る`;
    steps.push(
      own ? meetingStep(team.id, title, own) : { key: team.id, title, description: "日時は運営から追って連絡します。", url: null },
    );
  }

  if (steps.length === 0) {
    return (
      <EmptyState
        title="いまは案内する項目がありません"
        description="運営から連絡があるまでお待ちください"
        icon="check-square"
        testId="onboarding-public-empty"
      />
    );
  }
  return (
    <ol className={styles.publicSteps} data-testid="onboarding-public-steps">
      {steps.map((step, i) => (
        <li key={step.key} className={styles.publicStep} data-testid={`onboarding-public-step-${step.key}`}>
          <span className={styles.stepNumber} aria-hidden>
            {i + 1}
          </span>
          <div className={styles.onboardingBody}>
            <h2 className={styles.publicStepTitle}>{step.title}</h2>
            {step.when ? (
              <p className={styles.meetingWhen} data-testid={`onboarding-public-when-${step.key}`}>
                {step.when}
              </p>
            ) : null}
            {step.description ? <p className={styles.onboardingDescription}>{step.description}</p> : null}
            {step.url ? (
              <a className={styles.publicStepLink} href={step.url} target="_blank" rel="noreferrer noopener">
                {step.linkLabel ?? linkLabel(step.url)}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function meetingStep(key: string, title: string, m: OnboardingMeeting): Step {
  return {
    key,
    title,
    when: m.schedule,
    description: m.url ? "時間になったら下のリンクから入ってください。" : null,
    url: m.url,
    linkLabel: "参加リンクを開く",
  };
}

/** リンクの表示名: 「<ホスト名> を開く」（URL 全体は長くて読めないため）。 */
function linkLabel(url: string): string {
  try {
    return `${new URL(url).hostname} を開く`;
  } catch {
    return "開く";
  }
}
