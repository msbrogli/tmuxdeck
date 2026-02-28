import Foundation

struct FuzzyMatchResult {
    let match: Bool
    let score: Double
    let indices: [Int]

    static let noMatch = FuzzyMatchResult(match: false, score: 0, indices: [])
}

func fuzzyMatch(query: String, target: String) -> FuzzyMatchResult {
    let q = query.lowercased()
    let t = target.lowercased()

    if q.isEmpty { return FuzzyMatchResult(match: true, score: 0, indices: []) }

    let qChars = Array(q)
    let tChars = Array(t)
    var indices: [Int] = []
    var qi = 0
    var lastMatchIndex = -1
    var score: Double = 0

    for ti in 0..<tChars.count where qi < qChars.count {
        if tChars[ti] == qChars[qi] {
            indices.append(ti)
            // Consecutive matches score higher
            if lastMatchIndex == ti - 1 {
                score += 2
            } else {
                score += 1
            }
            // Bonus for matching at start or after separator
            if ti == 0 || tChars[ti - 1] == "/" || tChars[ti - 1] == "-" || tChars[ti - 1] == " " || tChars[ti - 1] == ":" {
                score += 3
            }
            lastMatchIndex = ti
            qi += 1
        }
    }

    if qi < qChars.count { return .noMatch }

    // Penalize long gaps between matches
    let span = indices.last! - indices.first! - indices.count + 1
    score -= Double(span) * 0.5

    return FuzzyMatchResult(match: true, score: score, indices: indices)
}
