import React, { useState } from 'react';
import { api } from '../../services/api';

const CreditManager: React.FC = () => {
  const [doctorId, setDoctorId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      const response = await api.post('/referrals/admin/credits', {
        doctorId,
        amount: parseFloat(amount),
        reason,
      });

      if (response.status === 201) {
        setSuccess('Credit added successfully!');
        setDoctorId('');
        setAmount('');
        setReason('');
      }
    } catch (err) {
      setError('Failed to add credit. Please check the details and try again.');
    }
  };

  return (
    <div className="manual-credit-card glass-card squircle-md">
      <div className="manual-credit-header">
        <div>
          <p className="manual-credit-kicker">Manual Credit</p>
          <h3>Adjust a doctor&apos;s balance</h3>
          <p>Add one-off credits for first orders, corrections, or retention incentives.</p>
        </div>
        <div className="manual-credit-meta">
          <span className="manual-credit-chip">Admin only</span>
          <span className="manual-credit-chip muted">Posts to ledger</span>
        </div>
      </div>

      {error && <div className="manual-credit-alert error">{error}</div>}
      {success && <div className="manual-credit-alert success">{success}</div>}

      <form className="manual-credit-form" onSubmit={handleSubmit}>
        <div className="manual-credit-grid">
          <label className="manual-credit-field">
            <span>Doctor ID</span>
            <input
              type="text"
              id="doctorId"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              required
              placeholder="e.g. doctor_123"
            />
          </label>

          <label className="manual-credit-field">
            <span>Amount (USD)</span>
            <input
              type="number"
              step="0.01"
              id="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              placeholder="50.00"
              min="0"
            />
          </label>

          <label className="manual-credit-field manual-credit-field--full">
            <span>Reason</span>
            <textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              placeholder="First order bonus, manual correction, etc."
            />
          </label>
        </div>

        <div className="manual-credit-actions">
          <button type="submit" className="manual-credit-submit">
            Add Credit
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreditManager;
