import Foundation

public struct ReceiptTotals: Decodable {
  public let turnCount: Int
  public let callCount: Int
  public let totalInputTokens: Int
  public let uncachedInputTokens: Int
  public let cacheReadTokens: Int
  public let cacheWriteTokens: Int
  public let outputTokens: Int
  public let thinkingTokens: Int
  public let totalTokens: Int
  public let cacheRatePct: Double?
  public let avgTps: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
  public let grossCostUsd: Double?
  public let pricedTurnCount: Int
  public let unpricedTurnCount: Int
}

public struct ReceiptItemRow: Decodable, Identifiable {
  public let id: String
  public let label: String
  public let sublabel: String?
  public let tool: String?
  public let priced: Bool
  public let sharePct: Double
  public let turnCount: Int
  public let callCount: Int
  public let totalInputTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let cacheRatePct: Double?
  public let avgTps: Double?
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
  public let grossCostUsd: Double?
}

public struct ReceiptTopProject: Decodable {
  public let name: String
  public let path: String
  public let costUsd: Double?
  public let totalTokens: Int
}

public struct ReceiptTopModel: Decodable {
  public let model: String
  public let costUsd: Double?
  public let totalTokens: Int
}

public struct ReceiptHighlights: Decodable {
  public let firstTurnAtMs: Double?
  public let lastTurnAtMs: Double?
  public let peakHour: String?
  public let hourlyCounts: [Int]?
  public let topProject: ReceiptTopProject?
  public let topModel: ReceiptTopModel?
}

public struct ReceiptAvailableDate: Decodable, Identifiable {
  public var id: String { date }
  public let date: String
  public let turnCount: Int
  public let totalInputTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let estimatedCostUsd: Double?
  public let cacheSavingsUsd: Double?
}

public struct ReceiptAgentModelRow: Decodable, Identifiable {
  public var id: String { model }
  public let model: String
  public let label: String
  public let priced: Bool
  public let turnCount: Int
  public let callCount: Int
  public let totalTokens: Int
  public let estimatedCostUsd: Double?
}

public struct ReceiptAgentGroup: Decodable, Identifiable {
  public var id: String { tool }
  public let tool: String
  public let label: String
  public let priced: Bool
  public let turnCount: Int
  public let callCount: Int
  public let totalTokens: Int
  public let estimatedCostUsd: Double?
  public let models: [ReceiptAgentModelRow]
}

public struct ReceiptDataResponse: Decodable {
  public let receiptNo: String
  public let scope: String
  public let date: String
  public let startDate: String
  public let weekdayLabel: String
  public let rangeLabel: String
  public let groupBy: String
  public let toolFilter: String
  public let generatedAtMs: Double
  public let activeTools: [String]
  public let streakDays: Int?
  public let vsDailyAvgRatio: Double?
  public let totals: ReceiptTotals
  public let items: [ReceiptItemRow]
  public let agentBreakdown: [ReceiptAgentGroup]?
  public let highlights: ReceiptHighlights?
  public let availableDates: [ReceiptAvailableDate]
  public let barcodeSeed: String
  public let punchlines: [String]
}

public struct PassiveToolSummary: Decodable {
  public let tool: String
  public let toolLabel: String
  public let status: String
  public let turnCount: Int
  public let anomalyCount: Int
  public let highSeverityCount: Int
  public let latestModel: String?
}

public struct PassiveBaselineRow: Decodable, Identifiable {
  public var id: String { "\(tool):\(model)" }
  public let tool: String
  public let toolLabel: String
  public let model: String
  public let turnCount: Int
  public let medianTps: Double?
  public let medianOutputTokens: Int?
  public let medianThinkingTokens: Int?
  public let thinkingRatio: Double?
}

public struct PassiveAnomalyRow: Decodable, Identifiable {
  public let id: String
  public let turnUid: String
  public let tool: String
  public let toolLabel: String
  public let model: String
  public let completedAtMs: Double
  public let kind: String
  public let severity: String
  public let title: String
  public let detail: String
}

public struct PassiveTelemetryReport: Decodable {
  public let scannedAtMs: Double
  public let days: Int
  public let totalTurnsScanned: Int
  public let overallStatus: String
  public let byTool: [String: PassiveToolSummary]
  public let baselines: [PassiveBaselineRow]
  public let anomalies: [PassiveAnomalyRow]
}

public struct CodexConfigSummary: Decodable {
  public let configured: Bool
  public let authMode: String
  public let model: String
  public let modelProvider: String
  public let baseUrl: String
  public let wireApi: String
  public let hasAccessToken: Bool
  public let hasApiKey: Bool
}

public struct FingerprintEndpointItem: Decodable, Identifiable {
  public let id: String
  public let name: String
  public let protocolType: String
  public let baseUrl: String
  public let model: String
  public let hasApiKey: Bool
  public let apiKeyPreview: String
  public let createdAtMs: Double

  enum CodingKeys: String, CodingKey {
    case id, name, baseUrl, model, hasApiKey, apiKeyPreview, createdAtMs
    case protocolType = "protocol"
  }
}

public struct FingerprintBaselineItem: Decodable, Identifiable {
  public let id: String
  public let name: String
  public let model: String
  public let targetName: String
  public let sampleCount: Int
  public let createdAtMs: Double
}

public struct FingerprintProbeItem: Decodable, Identifiable {
  public let id: String
  public let name: String
  public let weight: Int?
  public let passed: Bool
  public let score: Int?
  public let latencyMs: Int?
  public let reason: String?
  public let snippet: String?
}

public struct FingerprintRunDetails: Decodable {
  public let passedCount: Int?
  public let totalCount: Int?
  public let avgLatencyMs: Int?
  public let modelMismatch: Bool?
  public let probes: [FingerprintProbeItem]?
  public let totalSamples: Int?
  public let succeededSamples: Int?
  public let meanJsDistance: Double?
  public let maxJsDistance: Double?
  public let baselineName: String?
  public let turnStateLength: Int?
  public let safetyBuffering: String?
  public let headers: [String: String]?
  public let error: String?
}

public struct FingerprintRunItem: Decodable, Identifiable {
  public let id: String
  public let createdAtMs: Double
  public let targetType: String
  public let targetName: String
  public let tool: String?
  public let requestedModel: String?
  public let responseModel: String?
  public let mode: String
  public let verdict: String
  public let score: Int?
  public let jsDistance: Double?
  public let summary: String
  public let details: FingerprintRunDetails?
}

public struct ManualProbePack: Decodable {
  public let marker: String
  public let prompt: String
  public let questionCount: Int
}

public struct FingerprintOverviewResponse: Decodable {
  public let passive: PassiveTelemetryReport
  public let codex: CodexConfigSummary
  public let endpoints: [FingerprintEndpointItem]
  public let baselines: [FingerprintBaselineItem]
  public let runs: [FingerprintRunItem]
  public let manualProbe: ManualProbePack
}

public struct FingerprintRunResponse: Decodable {
  public let ok: Bool
  public let mode: String?
  public let error: String?
  public let run: FingerprintRunItem?
  public let passive: PassiveTelemetryReport?
}
