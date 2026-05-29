import { useState } from "react";
import CallSelectionIntake from "./pages/CallSelectionIntake";
import { IntakeResponse } from "./types/intake";

export default function App() {
  const [session, setSession] = useState<IntakeResponse | null>(null);

  if (session) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Session Created</h1>
          <p className="mt-2 text-gray-600">Session ID: {session.sessionId}</p>
          <p className="mt-1 text-sm text-gray-500">Status: {session.status}</p>
          <button
            onClick={() => setSession(null)}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Start New Session
          </button>
        </div>
      </div>
    );
  }

  return <CallSelectionIntake onSessionCreated={setSession} />;
}
