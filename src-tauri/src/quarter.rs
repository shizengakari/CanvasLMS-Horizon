//! Quarter extraction and course name normalization logic
//! Replicates `src/canvasService.js` quarter extraction and name cleanup with 100% parity.

use regex::Regex;
use std::sync::LazyLock;

static RE_Q_BRACKET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[(\[（【〈](\d)\s*Q[)\]）】〉]").unwrap());
static RE_Q_WORD_BOUNDARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b([1-4])\s*Q\b").unwrap());
static RE_Q_UNDERSCORE_SPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[\s_]([1-4])\s*Q").unwrap());
static RE_Q_JAPANESE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:第)?\s*([1-4])\s*(?:クォーター|クオーター|期)").unwrap());

static RE_CLEAN_BRACKET_Q: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[(\[（【〈]\s*[1-4１-４]\s*[QＱ]\s*[)\]）】〉]").unwrap());
static RE_CLEAN_WORD_Q: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[1-4１-４]\s*[QＱ]\b").unwrap());
static RE_CLEAN_JP_BRACKET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)[(\[（【〈]\s*(?:第)?\s*[1-4１-４]\s*(?:クォーター|クオーター|期)\s*[)\]）】〉]",
    )
    .unwrap()
});
static RE_CLEAN_JP_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:第)?\s*[1-4１-４]\s*(?:クォーター|クオーター|期)").unwrap()
});
static RE_CLEAN_EMPTY_BRACKET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[(\[（【〈]\s*[)\]）】〉]").unwrap());
static RE_CLEAN_WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// Normalize zenkaku digits and Q characters
fn normalize_course_name(input: &str) -> String {
    let converted: String = input
        .chars()
        .map(|c| match c {
            '０'..='９' => ((c as u32) - 0xFEE0) as u8 as char,
            'Ｑ' | 'ｑ' => 'Q',
            _ => c,
        })
        .collect();
    converted
}

/// Extract quarter string such as "1Q", "2Q", "3Q", "4Q" from course name
pub fn extract_quarter(course_name: &str) -> Option<String> {
    if course_name.trim().is_empty() {
        return None;
    }
    let normalized = normalize_course_name(course_name);

    if let Some(caps) = RE_Q_BRACKET.captures(&normalized) {
        if let Some(m) = caps.get(1) {
            if let Ok(num) = m.as_str().parse::<u32>() {
                if (1..=4).contains(&num) {
                    return Some(format!("{}Q", num));
                }
            }
        }
    }

    if let Some(caps) = RE_Q_WORD_BOUNDARY.captures(&normalized) {
        if let Some(m) = caps.get(1) {
            return Some(format!("{}Q", m.as_str()));
        }
    }

    if let Some(caps) = RE_Q_UNDERSCORE_SPACE.captures(&normalized) {
        if let Some(m) = caps.get(1) {
            return Some(format!("{}Q", m.as_str()));
        }
    }

    if let Some(caps) = RE_Q_JAPANESE.captures(&normalized) {
        if let Some(m) = caps.get(1) {
            return Some(format!("{}Q", m.as_str()));
        }
    }

    None
}

/// Remove quarter annotations from course name to provide a clean display title
pub fn clean_course_name(course_name: &str) -> String {
    if course_name.trim().is_empty() {
        return String::new();
    }

    let step1 = RE_CLEAN_BRACKET_Q.replace_all(course_name, "");
    let step2 = RE_CLEAN_WORD_Q.replace_all(&step1, "");
    let step3 = RE_CLEAN_JP_BRACKET.replace_all(&step2, "");
    let step4 = RE_CLEAN_JP_WORD.replace_all(&step3, "");
    let step5 = RE_CLEAN_EMPTY_BRACKET.replace_all(&step4, "");
    let step6 = RE_CLEAN_WHITESPACE.replace_all(&step5, " ");
    let cleaned = step6.trim();

    if cleaned.is_empty() {
        course_name.trim().to_string()
    } else {
        cleaned.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_quarter_brackets() {
        assert_eq!(extract_quarter("線形代数学 (1Q)"), Some("1Q".to_string()));
        assert_eq!(extract_quarter("微分積分学 [2Q]"), Some("2Q".to_string()));
        assert_eq!(extract_quarter("量子力学 【3Q】"), Some("3Q".to_string()));
        assert_eq!(extract_quarter("情報数理 〈4Q〉"), Some("4Q".to_string()));
    }

    #[test]
    fn test_extract_quarter_zenkaku() {
        assert_eq!(extract_quarter("力学（１Ｑ）"), Some("1Q".to_string()));
        assert_eq!(extract_quarter("力学 ２Ｑ"), Some("2Q".to_string()));
    }

    #[test]
    fn test_extract_quarter_japanese_text() {
        assert_eq!(
            extract_quarter("英語演習 第3クォーター"),
            Some("3Q".to_string())
        );
        assert_eq!(extract_quarter("科学技術論 4期"), Some("4Q".to_string()));
    }

    #[test]
    fn test_clean_course_name() {
        assert_eq!(clean_course_name("線形代数学 (1Q)"), "線形代数学");
        assert_eq!(clean_course_name("力学（１Ｑ）"), "力学");
        assert_eq!(clean_course_name("科学技術論 第4クォーター"), "科学技術論");
        assert_eq!(clean_course_name("単一コース名"), "単一コース名");
    }
}
