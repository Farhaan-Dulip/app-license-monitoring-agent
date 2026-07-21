import React, { useState } from 'react';
import './App.css';

const FeedbackForm = () => {
    const [email, setEmail] = useState('');
    const [rating, setRating] = useState(1);
    const [comments, setComments] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        // Add form submission logic
        alert(`Feedback submitted: \nEmail: ${email} \nRating: ${rating} \nComments: ${comments}`);
    };

    return (
        <div className="container">
            <h1>Feedback Form</h1>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="email">Email</label>
                    <input type="email" id="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter your email" />
                </div>
                <div className="form-group">
                    <label htmlFor="rating">Rating</label>
                    <input type="number" id="rating" min="1" max="5" required value={rating} onChange={(e) => setRating(e.target.value)} placeholder="Rate from 1 to 5" />
                </div>
                <div className="form-group">
                    <label htmlFor="comments">Comments</label>
                    <textarea id="comments" rows="4" required value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Your comments..."></textarea>
                </div>
                <button type="submit">Give Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;