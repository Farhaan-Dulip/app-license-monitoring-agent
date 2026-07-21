import React, { useState } from 'react';
import './App.css';

const FeedbackForm = () => {
    const [email, setEmail] = useState('');
    const [rating, setRating] = useState(0);
    const [comments, setComments] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = () => {
        setError('');
        if (!email) {
            setError('Email is required!');
            return;
        }
        alert(`Feedback submitted! Email: ${email}, Rating: ${rating}, Comments: ${comments}`);
    };

    return (
        <div className="container">
            <h1>Submit Your Feedback</h1>
            <div className="form-group">
                <label htmlFor="email">Email:</label>
                <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} aria-required="true" placeholder="Enter your email"/>
                {error && <div className="error" aria-live="assertive">{error}</div>}
            </div>
            <div className="form-group">
                <label>Ratings:</label>
                <div className="ratings">
                    {[1, 2, 3, 4, 5].map((value) => (
                        <span key={value} className={`star ${rating >= value ? 'selected' : ''}`} onClick={() => setRating(value)} data-value={value}>
                            ★
                        </span>
                    ))}
                </div>
            </div>
            <div className="form-group">
                <label htmlFor="comments">Comments:</label>
                <textarea id="comments" value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Share your experiences..." rows="4"></textarea>
            </div>
            <button className="submit-btn" onClick={handleSubmit}>Submit Feedback</button>
        </div>
    );
};

export default FeedbackForm;