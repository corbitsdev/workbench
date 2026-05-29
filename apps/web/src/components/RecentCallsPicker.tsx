import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { GranolaNote, IntakeRequest } from "../types/intake";

interface RecentCallsPickerProps {
  onSelect: (data: IntakeRequest) => void;
  isLoading?: boolean;
}

export default function RecentCallsPicker({ onSelect, isLoading = false }: RecentCallsPickerProps) {
  const [calls, setCalls] = useState<GranolaNote[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    fetchRecentCalls();
  }, []);

  const fetchRecentCalls = async () => {
    try {
      setLoading(true);
      setError("");

      const response = await fetch("/api/recent-calls", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch recent calls");
      }

      const data = await response.json();
      setCalls(data.calls || []);
    } catch (err) {
      setError((err instanceof Error ? err.message : "Failed to load recent calls"));
      setCalls([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (callId: string) => {
    setSelectedId(callId);
    onSelect({
      granolaId: callId,
      source: "granola",
    });
  };

  if (loading) {
    return (
      <motion.div
        className="space-y-3"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 bg-gray-100 rounded-lg animate-pulse" />
        ))}
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div
        className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-700 text-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <p className="font-medium">{error}</p>
        <p className="mt-2 text-xs">Make sure Granola API is configured in your environment</p>
      </motion.div>
    );
  }

  if (calls.length === 0) {
    return (
      <motion.div
        className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-gray-600 text-sm text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <p>No recent calls found</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="space-y-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      {calls.map((call) => (
        <motion.button
          key={call.id}
          onClick={() => handleSelect(call.id)}
          disabled={isLoading || selectedId !== null}
          className={`w-full p-4 text-left border rounded-lg transition-colors ${
            selectedId === call.id
              ? "bg-blue-50 border-blue-300 ring-2 ring-blue-500"
              : "border-gray-200 hover:bg-gray-50"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
          whileHover={{ y: -2 }}
          whileTap={{ y: 0 }}
        >
          <p className="font-medium text-gray-900">{call.title}</p>
          <p className="text-sm text-gray-500 mt-1">
            {new Date(call.created_at).toLocaleDateString()}
            {call.participants && call.participants.length > 0 && ` • ${call.participants.length} participants`}
          </p>
        </motion.button>
      ))}
    </motion.div>
  );
}
