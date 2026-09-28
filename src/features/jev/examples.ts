import type { JevInput } from "./types";
export const examples: { name: string; input: JevInput }[] = [
  {
    name: "問い合わせの振り分け",
    input: {
      state: {
        message: "同じ注文の代金が二度請求されています。返金をお願いします。",
        order_status: "delivered",
      },
      questions: {
        department: {
          type: "choice",
          instructions: "この問い合わせの主な担当窓口を選んでください。",
          criteria: {
            billing: "請求、支払い、返金に関する問い合わせ",
            delivery: "配送、未着、届け先に関する問い合わせ",
            other: "いずれにも該当しない問い合わせ",
          },
        },
        requests_refund: {
          type: "noul",
          instructions: "利用者は返金を求めている。",
        },
        request_specificity: {
          type: "score",
          instructions: "利用者が求める対応の具体性を評価してください。",
          criteria: [
            "困りごとは書かれているが、求める対応は不明",
            "対応の方向性は分かるが、具体的な行為は不明",
            "求める具体的な行為が明示されている",
          ],
        },
      },
    },
  },
  {
    name: "記事ジャンル",
    input: {
      state: "市内の美術館で、若手作家による写真展が土曜日から開催されます。",
      questions: {
        genre: {
          type: "choice",
          instructions: "記事の主なジャンルを選んでください。",
          criteria: {
            culture: "芸術や文化",
            sports: "競技や試合",
            technology: "技術や製品",
          },
        },
      },
    },
  },
  {
    name: "案内文の条件",
    input: {
      state:
        "読書会は10月3日午後2時、中央図書館の会議室で開催します。参加希望の方はメールでお申し込みください。",
      questions: {
        has_place: {
          type: "noul",
          instructions: "案内文には会場の名称が明記されている。",
        },
        detail: {
          type: "score",
          instructions: "参加に必要な情報の充足度を評価してください。",
          criteria: [
            "日時・会場ともに不明",
            "日時または会場が分かる",
            "日時と会場と申込方法が分かる",
          ],
        },
      },
    },
  },
];
