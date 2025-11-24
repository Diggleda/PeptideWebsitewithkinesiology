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
    <div className="card">
      <div className="card-body">
        <h5 className="card-title">Manual Credit Adjustment</h5>
        {error && <div className="alert alert-danger">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}
        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label htmlFor="doctorId" className="form-label">
              Doctor ID
            </label>
            <input
              type="text"
              className="form-control"
              id="doctorId"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              required
            />
          </div>
          <div className="mb-3">
            <label htmlFor="amount" className="form-label">
              Amount
            </label>
            <input
              type="number"
              step="0.01"
              className="form-control"
              id="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          <div className="mb-3">
            <label htmlFor="reason" className="form-label">
              Reason
            </label>
            <textarea
              className="form-control"
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            ></textarea>
          </div>
          <button type="submit" className="btn btn-primary">
            Add Credit
          </button>
        </form>
      </div>
    </div>
  );
};

export default CreditManager;
